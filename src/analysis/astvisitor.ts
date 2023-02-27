import traverse, {NodePath} from "@babel/traverse";
import {
    ArrayExpression,
    ArrowFunctionExpression,
    AssignmentExpression,
    AssignmentPattern,
    AwaitExpression,
    CallExpression,
    ClassAccessorProperty,
    ClassDeclaration,
    ClassExpression,
    ClassMethod,
    ClassPrivateMethod,
    ClassPrivateProperty,
    ClassProperty,
    ConditionalExpression,
    ExportAllDeclaration,
    ExportDefaultDeclaration,
    ExportNamedDeclaration,
    File,
    ForOfStatement,
    Function,
    FunctionDeclaration,
    FunctionExpression,
    Identifier,
    ImportDeclaration,
    isArrayPattern,
    isArrowFunctionExpression,
    isAssignmentExpression,
    isAssignmentPattern,
    isClassAccessorProperty,
    isClassExpression,
    isClassMethod,
    isClassPrivateMethod,
    isClassPrivateProperty,
    isClassProperty,
    isDeclaration,
    isExportDeclaration,
    isExportDefaultDeclaration,
    isExportDefaultSpecifier,
    isExportNamedDeclaration,
    isExpression,
    isFunctionDeclaration,
    isFunctionExpression,
    isIdentifier,
    isImportDefaultSpecifier,
    isImportSpecifier,
    isLVal,
    isObjectMethod,
    isObjectPattern,
    isObjectProperty,
    isPattern,
    isRestElement,
    isSpreadElement,
    JSXElement,
    JSXMemberExpression,
    LogicalExpression,
    LVal,
    MemberExpression,
    NewExpression,
    ObjectExpression,
    ObjectMethod,
    ObjectProperty,
    OptionalCallExpression,
    OptionalMemberExpression,
    Program,
    RegExpLiteral,
    ReturnStatement,
    SequenceExpression,
    StaticBlock,
    Super,
    TaggedTemplateExpression,
    ThisExpression,
    ThrowStatement,
    variableDeclaration,
    variableDeclarator,
    VariableDeclarator,
    WithStatement,
    YieldExpression
} from "@babel/types";
import {
    AccessPathToken,
    AllocationSiteToken,
    ClassToken,
    FunctionToken,
    NativeObjectToken,
    ObjectToken,
    PackageObjectToken,
    Token
} from "./tokens";
import {ModuleInfo} from "./infos";
import logger from "../misc/logger";
import {mapArrayAdd, sourceLocationToStringWithFile, SourceLocationWithFilename} from "../misc/util";
import assert from "assert";
import {globalLoc, undefinedIdentifier} from "./analysisstate";
import {options} from "../options";
import {ComponentAccessPath, PropertyAccessPath} from "./accesspaths";
import {ConstraintVar} from "./constraintvars";
import {
    getBaseAndProperty,
    getClass,
    getExportName,
    getImportName,
    getKey,
    getProperty,
    isParentExpressionStatement
} from "../misc/asthelpers";
import {
    ASYNC_GENERATOR_PROTOTYPE_NEXT,
    GENERATOR_PROTOTYPE_NEXT,
    PROMISE_FULFILLED_VALUES
} from "../natives/ecmascript";
import {Operations} from "./operations";
import {TokenListener} from "./listeners";

export const IDENTIFIER_PATH = Symbol();

export function visit(ast: File, op: Operations) {
    const solver = op.solver;
    const a = solver.analysisState;
    let nextNodeIndex = 1;

    a.maybeEscaping.clear(); // TODO: move to method in AnalysisState?

    // traverse the AST and extend the analysis result with information about the current module
    if (logger.isVerboseEnabled())
        logger.verbose(`Traversing AST of ${op.file}`);
    traverse(ast, {

        enter(path: NodePath) {

            // workaround to ensure that AST nodes with undefined location (caused by desugaring) can be identified uniquely
            if (!path.node.loc) {
                let p: NodePath | null = path;
                while (p && !p.node.loc)
                    p = p.parentPath;
                path.node.loc = {filename: op.file, start: p?.node.loc?.start, end: p?.node.loc?.end, nodeIndex: nextNodeIndex++} as any; // see sourceLocationToString
            }
        },

        Program(path: NodePath<Program>) {

            // set module source location
            op.moduleInfo.loc = path.node.loc;

            // artificially declare all globals in the program scope (if not already declared)
            const decls = [...op.globals, undefinedIdentifier] // TODO: treat 'undefined' like other globals?
                .filter(d => path.scope.getBinding(d.name) === undefined)
                .map(id => {
                    const d = variableDeclarator(id);
                    d.loc = globalLoc;
                    return d;
                });
            const d = variableDeclaration("var", decls);
            d.loc = globalLoc;
            path.scope.registerDeclaration(path.unshiftContainer("body", d)[0]);
        },

        ThisExpression(path: NodePath<ThisExpression>) {

            // this
            a.registerThis(path);

            // constraint: t ∈ ⟦this⟧ where t denotes the package
            solver.addTokenConstraint(op.packageObjectToken, a.varProducer.nodeVar(path.node));

            const fun = path.getFunctionParent();
            if (fun) {

                // constraint: ⟦this_f⟧ ⊆ ⟦this⟧ where f is the enclosing function
                solver.addSubsetConstraint(a.varProducer.thisVar(fun.node), a.varProducer.nodeVar(path.node));
            } else {

                // constraint %globalThis ∈ ⟦this⟧
                solver.addTokenConstraint(op.natives.get("globalThis")!, a.varProducer.nodeVar(path.node));
            }

            // constraint: @Unknown ∈ ⟦this⟧
            solver.addAccessPath(op.theUnknownAccessPath, a.varProducer.nodeVar(path.node)); // TODO: omit this constraint in certain situations?
        },

        Identifier(path: NodePath<Identifier>) {
            if (path.node.name === "arguments") // registers use of 'arguments'
                a.varProducer.identVar(path.node, path); // FIXME: registerArguments may be called too late if the function is recursive

            if (options.variableKinds) {
                (path.node as any)[IDENTIFIER_PATH] = path;
            }
        },

        MemberExpression: { // TODO: actually more efficient to visit nodes bottom-up? (if not, most rules don't need to use 'exit')
            exit(path: NodePath<MemberExpression>) {
                visitMemberExpression(path);
            }
        },

        OptionalMemberExpression: {
            exit(path: NodePath<OptionalMemberExpression>) {
                visitMemberExpression(path);
            }
        },

        JSXMemberExpression: {
            exit(path: NodePath<JSXMemberExpression>) {
                visitMemberExpression(path);
            }
        },

        ReturnStatement: {
            exit(path: NodePath<ReturnStatement>) {
                if (path.node.argument) {
                    const fun = path.getFunctionParent();
                    if (fun) {
                        const expVar = op.expVar(path.node.argument, path);

                        // return E
                        let resVar;
                        if (fun.node.generator) {
                            // find the iterator object (it is returned via Function)
                            // constraint: ... ⊆ ⟦i.value⟧ where i is the iterator object for the function
                            const iter = a.canonicalizeToken(new AllocationSiteToken("Iterator", fun.node.body, op.packageInfo));
                            resVar = a.varProducer.objPropVar(iter, "value");
                        } else {
                            // constraint: ... ⊆ ⟦ret_f⟧ where f is the enclosing function (ignoring top-level returns)
                            resVar = a.varProducer.returnVar(fun.node);
                        }

                        if (fun.node.async && !fun.node.generator) {
                            // make a new promise with the fulfilled value being the return value
                            const promise = op.newPromiseToken(fun.node);
                            solver.addSubsetConstraint(expVar, a.varProducer.objPropVar(promise, PROMISE_FULFILLED_VALUES));
                            solver.addTokenConstraint(promise!, resVar);
                        } else
                            solver.addSubsetConstraint(expVar, resVar);
                    }
                }
            }
        },

        Function(path: NodePath<Function>) { // FunctionDeclaration | FunctionExpression | ObjectMethod | ArrowFunctionExpression | ClassMethod | ClassPrivateMethod
            // record that a function/method/constructor/getter/setter has been reached, connect to its enclosing function or module
            const fun = path.node;
            let cls;
            if (isClassMethod(fun) && fun.kind === "constructor")
                cls = getClass(path);
            const name = isFunctionDeclaration(path.node) || isFunctionExpression(path.node) ? path.node.id?.name :
                (isObjectMethod(path.node) || isClassMethod(path.node)) ? getKey(path.node) :
                    cls ? cls.id?.name : undefined;// for constructors, use the class name if present
            const anon = isFunctionDeclaration(path.node) || isFunctionExpression(path.node) ? path.node.id === null : isArrowFunctionExpression(path.node);
            const loc = cls ? cls.loc : // for constructors, use the class location (workaround to match dyn.ts)
                isClassMethod(fun) && fun.static ? {filename: (fun.key.loc as SourceLocationWithFilename).filename, start: fun.key.loc!.start, end: fun.loc!.end} : // for static methods, use the identifier location (workaround to match dyn.ts)
                    fun.loc;
            const msg = cls ? "constructor" : `${name ?? (anon ? "<anonymous>" : "<computed>")}`;
            if (logger.isVerboseEnabled())
                logger.verbose(`Reached function ${msg} at ${sourceLocationToStringWithFile(loc)}`);
            a.registerFunctionInfo(op.file, path, name, fun, loc);
            if (!name && !anon)
                a.warnUnsupported(fun, `Computed ${isFunctionDeclaration(path.node) || isFunctionExpression(path.node) ? "function" : "method"} name`); // TODO: handle functions/methods with unknown name?

            if (fun.generator) {

                // function*

                // constraint: %(Async)Generator.prototype.next ⊆ ⟦i.next⟧ where i is the iterator object for the function
                const iter = a.canonicalizeToken(new AllocationSiteToken("Iterator", fun.body, op.packageInfo));
                const iterNext = a.varProducer.objPropVar(iter, "next");
                solver.addTokenConstraint(op.natives.get(fun.async ? ASYNC_GENERATOR_PROTOTYPE_NEXT : GENERATOR_PROTOTYPE_NEXT)!, iterNext);

                // constraint i ∈ ⟦ret_f⟧ where i is the iterator object for the function
                solver.addTokenConstraint(iter, a.varProducer.returnVar(fun));
            }
        },

        FunctionDeclaration: {
            exit(path: NodePath<FunctionDeclaration>) {

                // function f(...) {...}  (as declaration)
                // constraint: t ∈ ⟦f⟧ where t denotes the function
                const to = path.node.id ? path.node.id : path.node; // export default functions may not have names, use the FunctionDeclaration node as constraint variable in that situation
                solver.addTokenConstraint(op.newFunctionToken(path.node), a.varProducer.nodeVar(to));
            }
        },

        FunctionExpression: {
            exit(path: NodePath<FunctionExpression>) {

                // function f(...) {...} (as expression, possibly without name)
                // constraint: t ∈ ⟦function f(...) {...}⟧ where t denotes the function
                if (!isParentExpressionStatement(path))
                    solver.addTokenConstraint(op.newFunctionToken(path.node), a.varProducer.nodeVar(path.node));
                // constraint: t ∈ ⟦f⟧ (if the function is named) where t denotes the function
                if (path.node.id)
                    solver.addTokenConstraint(op.newFunctionToken(path.node), a.varProducer.nodeVar(path.node.id));
            }
        },

        ArrowFunctionExpression: {
            exit(path: NodePath<ArrowFunctionExpression>) {

                // (...) => E
                // constraint: t ∈ ⟦(...) => E⟧ where t denotes the function
                if (!isParentExpressionStatement(path))
                    solver.addTokenConstraint(op.newFunctionToken(path.node), a.varProducer.nodeVar(path.node));
                // constraint: ⟦E⟧ ⊆ ⟦ret_f⟧ where f is the function
                if (isExpression(path.node.body))
                    solver.addSubsetConstraint(op.expVar(path.node.body, path), a.varProducer.returnVar(path.node));
            }
        },

        CallExpression: {
            exit(path: NodePath<CallExpression>) {

                // E0(E1,...)
                visitCallOrNew(false, path);
            }
        },

        OptionalCallExpression: {
            exit(path: NodePath<OptionalCallExpression>) {

                // E?.E0(E1,...)
                visitCallOrNew(false, path);
            }
        },

        NewExpression: {
            exit(path: NodePath<NewExpression>) {

                // new E0(E1,...)
                visitCallOrNew(true, path);
            }
        },

        AssignmentExpression: {
            exit(path: NodePath<AssignmentExpression>) {
                const oper = path.node.operator;
                if (oper === '=' || oper === '||=' || oper === '&&=' || oper === '??=') {
                    const eVar = op.expVar(path.node.right, path);
                    op.assign(eVar, path.node.left, path.node, a.getEnclosingFunctionOrModule(path, op.moduleInfo), path, false);

                    // constraint: ⟦E⟧ ⊆ ⟦... = E⟧
                    if (!isParentExpressionStatement(path))
                        solver.addSubsetConstraint(eVar, a.varProducer.nodeVar(path.node));
                }
            }
        },

        AssignmentPattern: {
            exit(path: NodePath<AssignmentPattern>) {

                // X = E (as default value)
                // constraint: ⟦E⟧ ⊆ ⟦X⟧ (if X is a simple identifier...)
                op.assign(op.expVar(path.node.right, path), path.node.left, path.node, a.getEnclosingFunctionOrModule(path, op.moduleInfo), path, false);
            }
        },

        VariableDeclarator: { // handles VariableDeclaration
            exit(path: NodePath<VariableDeclarator>) {
                if (path.node.init) {

                    // var/let/const X = E
                    // constraint: ⟦E⟧ ⊆ ⟦X⟧ (if X is a simple identifier...)
                    op.assign(op.expVar(path.node.init, path), path.node.id, path.node, a.getEnclosingFunctionOrModule(path, op.moduleInfo), path, false);
                }
            }
        },

        ConditionalExpression: {
            exit(path: NodePath<ConditionalExpression>) {

                // E1 ? E2 : E3
                // constraints: ⟦E2⟧ ⊆ ⟦E1 ? E2 : E3⟧, ⟦E3⟧ ⊆ ⟦E1 ? E2 : E3⟧
                if (!isParentExpressionStatement(path)) {
                    solver.addSubsetConstraint(op.expVar(path.node.consequent, path), a.varProducer.nodeVar(path.node));
                    solver.addSubsetConstraint(op.expVar(path.node.alternate, path), a.varProducer.nodeVar(path.node));
                }
            }
        },

        LogicalExpression: {
            exit(path: NodePath<LogicalExpression>) {

                // E1 op E2 where op is ||, && or ??
                // constraints: ⟦E1⟧ ⊆ ⟦E1 op E2⟧, ⟦E2⟧ ⊆ ⟦E1 op E2⟧
                // (the former can safely be omitted for && when only tracking functions and objects)
                if (!isParentExpressionStatement(path)) {
                    if (path.node.operator !== "&&")
                        solver.addSubsetConstraint(op.expVar(path.node.left, path), a.varProducer.nodeVar(path.node));
                    solver.addSubsetConstraint(op.expVar(path.node.right, path), a.varProducer.nodeVar(path.node));
                }
            }
        },

        SequenceExpression: {
            exit(path: NodePath<SequenceExpression>) { // TODO: handle in expVar (like ParenthesizedExpression) to reduce size of constraint graph?

                // (..., ..., E)
                // constraint: ⟦E⟧ ⊆ ⟦(..., ..., E)⟧
                if (!isParentExpressionStatement(path))
                    solver.addSubsetConstraint(op.expVar(path.node.expressions[path.node.expressions.length - 1], path), a.varProducer.nodeVar(path.node));
            }
        },

        Property: { // ObjectProperty | ClassProperty | ClassAccessorProperty | ClassPrivateProperty
            exit(path: NodePath<ObjectProperty | ClassProperty | ClassAccessorProperty | ClassPrivateProperty>) {
                if (isPattern(path.parent))
                    return; // pattern properties are handled at assign
                if (isClassAccessorProperty(path.node))
                    assert.fail(`Encountered ClassAccessorProperty at ${sourceLocationToStringWithFile(path.node.loc)}`); // https://github.com/tc39/proposal-grouped-and-auto-accessors
                const key = getKey(path.node);
                if (key) {
                    if (path.node.value) {
                        if (!isExpression(path.node.value))
                            assert.fail(`Unexpected Property value type ${path.node.value?.type} at ${sourceLocationToStringWithFile(path.node.loc)}`);

                        // {..., p: E, ...} or class... {...; p = E; ...} (static or non-static, private or public)
                        const rightvar = op.expVar(path.node.value, path);
                        let dst;
                        if (options.alloc && isObjectProperty(path.node)) {
                            // constraint: ⟦E⟧ ⊆ ⟦i.p⟧ where i is the object literal
                            dst = a.varProducer.objPropVar(a.canonicalizeToken(new ObjectToken(path.parentPath.node, op.packageInfo)), key);
                        } else if (options.alloc && (isClassProperty(path.node) || isClassAccessorProperty(path.node) || isClassPrivateProperty(path.node)) && path.node.static) {
                            // constraint: ⟦E⟧ ⊆ ⟦c.p⟧ where c is the class
                            const cls = getClass(path);
                            assert(cls);
                            dst = a.varProducer.objPropVar(a.canonicalizeToken(new ClassToken(cls, op.packageInfo)), key);
                        } else {
                            // constraint: ⟦E⟧ ⊆ ⟦k.p⟧ where k is the current package
                            dst = a.varProducer.packagePropVar(op.file, key);
                        }
                        solver.addSubsetConstraint(rightvar, dst);
                        // TODO: special treatment for ClassPrivateProperty? static properties?
                    }
                } else
                    a.warnUnsupported(path.node, "Computed property name"); // TODO: nontrivial computed property name
                if (isClassProperty(path.node)) // dyn.ts treats class property initializers as functions
                    a.registerArtificialFunction(op.moduleInfo, path.node.key);
            }
        },

        Method: { // ObjectMethod | ClassMethod | ClassPrivateMethod
            exit(path: NodePath<ObjectMethod | ClassMethod | ClassPrivateMethod>) {
                switch (path.node.kind) {
                    case "method":
                    case "get":
                    case "set":
                        const key = getKey(path.node);
                        if (key) {

                            // [class C...] {... p(..) {...} ...}  (static or non-static, private or public)
                            const t = op.newFunctionToken(path.node);
                            const ac = path.node.kind === "method" ? "normal" : path.node.kind;
                            let dst;
                            if (options.alloc && isObjectMethod(path.node)) {
                                // constraint: t ∈ ⟦(ac)i.p⟧ where t denotes the function, i is the object literal,
                                // and (ac) specifies whether it is a getter, setter or normal property
                                dst = a.varProducer.objPropVar(a.canonicalizeToken(new ObjectToken(path.parentPath.node, op.packageInfo)), key, ac);
                            } else if (options.alloc && (isClassMethod(path.node) || isClassPrivateMethod(path.node)) && path.node.static) {
                                // constraint: t ∈ ⟦(ac)c.p⟧ where t denotes the function, c is the class,
                                // and (ac) specifies whether it is a getter, setter or normal property
                                const cls = getClass(path);
                                assert(cls);
                                dst = a.varProducer.objPropVar(a.canonicalizeToken(new ClassToken(cls, op.packageInfo)), key, ac);

                            } else {
                                // constraint: t ∈ ⟦(ac)k.p⟧ where t denotes the function and k is the current package,
                                // and (ac) specifies whether it is a getter, setter or normal property
                                dst = a.varProducer.packagePropVar(op.file, key, ac);
                            }
                            solver.addTokenConstraint(t, dst);
                            // TODO: special treatment for ClassPrivateMethod? static properties?
                        } else
                            a.warnUnsupported(path.node, "Computed method name"); // TODO: nontrivial computed method name
                        break;
                    case "constructor":

                        // class C... {... constructor(..) {...} ...}
                        // constraint: t ∈ ⟦C⟧ where t denotes the constructor function
                        const cls = getClass(path);
                        if (cls && cls.id) // note: to match dyn.ts, the FunctionToken uses the actual constructor location, but the FunctionInfo uses the location of the class
                            solver.addTokenConstraint(op.newFunctionToken(path.node), a.varProducer.nodeVar(cls.id));
                        break;
                }
                // TODO: currently ignoring generator, async, static (often easy to resolve!), override, optional, abstract
            }
        },

        Class: { // ClassExpression | ClassDeclaration
            exit(path: NodePath<ClassExpression | ClassDeclaration>) {

                if (path.node.superClass) {

                    // class C extends E {...}
                    // constraint: ⟦E⟧ ⊆ ⟦extends_c⟧ where c is the class
                    solver.addSubsetConstraint(op.expVar(path.node.superClass, path), a.varProducer.extendsVar(path.node)); // TODO: test class inheritance (see C11 in classes.js)
                }

                let constructor: ClassMethod | ClassPrivateMethod | undefined;
                for (const b of path.node.body.body)
                    if ((isClassMethod(b) || isClassPrivateMethod(b)) && b.kind === "constructor")
                        constructor = b;
                const exported = isExportDeclaration(path.parent);
                if (constructor) {
                    if (isClassExpression(path.node) || exported) {

                        // class ... {...}
                        // constraint: t ∈ ⟦class ... {...}⟧ where t denotes the constructor function
                        if (!isParentExpressionStatement(path) || exported)
                            solver.addTokenConstraint(op.newFunctionToken(constructor), a.varProducer.nodeVar(path.node));
                    }
                } else // no explicit constructor (dyn.ts records a call to an implicit constructor)
                    a.registerArtificialFunction(op.moduleInfo, path.node);

                // class ... {...}
                // constraint: c ∈ ⟦class ... {...}⟧ where c is the ClassToken
                const ct = op.newClassToken(path.node);
                if (isClassExpression(path.node) || exported)
                    solver.addTokenConstraint(ct, a.varProducer.nodeVar(path.node));

                // constraint: c ∈ ⟦C⟧ where c is the ClassToken
                if (path.node.id)
                    solver.addTokenConstraint(ct, a.varProducer.nodeVar(path.node.id));
            }
        },

        ObjectExpression(path: NodePath<ObjectExpression>) {

            // {...}
            if (!isParentExpressionStatement(path)) {

                // constraint: t ∈ ⟦{...}⟧ where t is the object for this allocation site
                solver.addTokenConstraint(op.newObjectToken(path.node), a.varProducer.nodeVar(path.node));
                // TODO: fall back to field-based if an object token appears in a constraint variable together with >k other object tokens? (see analysisstate.add)

                for (const p of path.node.properties)
                    if (isSpreadElement(p)) {
                        a.warnUnsupported(p, "SpreadElement in ObjectExpression"); // TODO: SpreadElement in ObjectExpression
                    } // (ObjectProperty and ObjectMethod are handled at rules Property and Method respectively)
            }
        },

        ArrayExpression(path: NodePath<ArrayExpression>) {

            // [...]
            if (!isParentExpressionStatement(path)) {

                // constraint: t ∈ ⟦{...}⟧ where t is the array for this allocation site
                const t = op.newArrayToken(path.node);
                solver.addTokenConstraint(t, a.varProducer.nodeVar(path.node));

                for (const [index, e] of path.node.elements.entries())
                    if (isExpression(e)) {

                        // constraint: ⟦E⟧ ⊆ ⟦t.i⟧ for each array element E with index i
                        const prop = String(index);
                        solver.addSubsetConstraint(op.expVar(e, path), a.varProducer.objPropVar(t, prop));
                    } else if (e)
                        a.warnUnsupported(e, "SpreadElement in ArrayExpression"); // TODO: SpreadElement in ArrayExpression
            }
        },

        StaticBlock(path: NodePath<StaticBlock>) {
            a.registerArtificialFunction(op.moduleInfo, path.node); // dyn.ts treats static blocks as functions
        },

        ThrowStatement: {
            exit(path: NodePath<ThrowStatement>) {
                a.registerEscaping(op.expVar(path.node.argument, path));
            }
        },

        CatchClause: {
            // TODO: CatchClause
        },

        Super(path: NodePath<Super>) {
            a.warnUnsupported(path.node); // TODO: super
        },

        ImportDeclaration(path: NodePath<ImportDeclaration>) {

            // model 'import' like 'require'
            op.requireModule(path.node.source.value, a.varProducer.nodeVar(path.node), path); // TODO: see TODO in requireResolve about using import.meta.resolve

            let any = false;
            for (const imp of path.node.specifiers) {
                switch (imp.type) {
                    case "ImportNamespaceSpecifier":

                        // bind the module export object to the namespace identifier
                        solver.addSubsetConstraint(a.varProducer.nodeVar(path.node), a.varProducer.nodeVar(imp.local));
                        break;

                    case "ImportSpecifier":
                    case "ImportDefaultSpecifier":
                        any = true;
                        break;
                }
                // record identifier uses for pattern matcher
                const refs = path.scope.getBinding(imp.local.name)?.referencePaths;
                if (refs)
                    for (const ref of refs)
                        mapArrayAdd(imp.local, ref.node, a.importDeclRefs);
            }
            // bind each module export object property to the local identifier
            if (any) {

                // constraint: ∀ objects t ∈ ⟦import...⟧: ⟦t.p⟧ ⊆ ⟦x⟧ where p is the property and x is the local identifier
                // for each import specifier
                solver.addForAllConstraint(a.varProducer.nodeVar(path.node), TokenListener.IMPORT_BASE, path.node, (t: Token) => {
                    for (const imp of path.node.specifiers)
                        if (isImportSpecifier(imp) || isImportDefaultSpecifier(imp)) {
                            const prop = getImportName(imp);
                            if (t instanceof AllocationSiteToken || t instanceof FunctionToken || t instanceof NativeObjectToken || t instanceof PackageObjectToken)
                                solver.addSubsetConstraint(a.varProducer.objPropVar(t, prop), a.varProducer.nodeVar(imp.local));
                            else if (t instanceof AccessPathToken) // TODO: treat as object along with other tokens above?
                                solver.addAccessPath(a.canonicalizeAccessPath(new PropertyAccessPath(a.varProducer.nodeVar(path.node), prop)), a.varProducer.nodeVar(imp.local), t.ap); // TODO: describe this constraint...
                        }
                });
            }
        },

        ExportDeclaration(path: NodePath<ExportAllDeclaration | ExportDefaultDeclaration | ExportNamedDeclaration>) {
            switch (path.node.type) {
                case "ExportNamedDeclaration": // examples: export const { prop: name } = { prop: ... }, export { x as y }
                case "ExportDefaultDeclaration": // example: export default E;
                    if (path.node.declaration) {
                        assert(!isExportNamedDeclaration(path.node) || path.node.specifiers.length === 0, "Unexpected specifiers at ExportNamedDeclaration with declaration");
                        assert(!isExportNamedDeclaration(path.node) || !path.node.source, "Unexpected source at ExportNamedDeclaration with declaration");
                        const decl = path.node.declaration;
                        switch (decl.type) {
                            case "FunctionDeclaration": // example: export function x() {...}
                            case "ClassDeclaration": { // example: export class x {...}
                                const from = decl.id ? decl.id : decl; // using the declaration node as constraint variable for anonymous functions and classes
                                assert(isExportDefaultDeclaration(path.node) || decl.id, "Unexpected missing id");
                                const prop = isExportDefaultDeclaration(path.node) ? "default" : decl.id!.name;
                                solver.addSubsetConstraint(a.varProducer.nodeVar(from), a.varProducer.objPropVar(op.exportsObjectToken, prop));
                                break;
                            }
                            case "VariableDeclaration": { // example: export var x = ... (local declaration and init value handled at rule VariableDeclarator)
                                function exportDeclared(lval: LVal) {
                                    if (isIdentifier(lval))
                                        solver.addSubsetConstraint(a.varProducer.nodeVar(lval), a.varProducer.objPropVar(op.exportsObjectToken, lval.name));
                                    else if (isAssignmentPattern(lval))
                                        exportDeclared(lval.left);
                                    else if (isObjectPattern(lval)) {
                                        for (const p of lval.properties)
                                            if (isRestElement(p))
                                                exportDeclared(p.argument);
                                            else {
                                                if (!isLVal(p.value))
                                                    assert.fail(`Unexpected expression ${p.value.type}, expected LVal`);
                                                exportDeclared(p.value);
                                            }
                                    } else if (isArrayPattern(lval)) {
                                        for (const p of lval.elements)
                                            if (p)
                                                if (isRestElement(p))
                                                    exportDeclared(p.argument);
                                                else
                                                    exportDeclared(p);
                                    } else
                                        assert.fail(`Unexpected LVal type ${lval.type}`);
                                }
                                for (const decl2 of decl.declarations)
                                    exportDeclared(decl2.id);
                                break;
                            }
                            default: {
                                if (isDeclaration(decl))
                                    assert.fail(`Unexpected declaration type ${decl.type} in ExportDeclaration`);
                                if (isExpression(decl))
                                    solver.addSubsetConstraint(op.expVar(decl, path), a.varProducer.objPropVar(op.exportsObjectToken, "default"));
                                break;
                            }
                        }
                    } else {
                        if (!isExportNamedDeclaration(path.node))
                            assert.fail(`Unexpected node type ${path.node.type}`);
                        const node = path.node;
                        function getExportVar(name: string): ConstraintVar | undefined {
                            const m = node.source ? op.requireModule(node.source.value, a.varProducer.nodeVar(node), path) : undefined;
                            return m instanceof ModuleInfo ? a.varProducer.objPropVar(a.canonicalizeToken(new NativeObjectToken("exports", m)), name) : undefined;
                        }
                        for (const spec of path.node.specifiers)
                            switch (spec.type) {
                                case "ExportSpecifier": // example: export {x as y} ...
                                case "ExportDefaultSpecifier": // example: export x from "m"
                                    const from = isExportDefaultSpecifier(spec) ? getExportVar("default") : node.source ? getExportVar(spec.local.name) : a.varProducer.identVar(spec.local, path);
                                    solver.addSubsetConstraint(from, a.varProducer.objPropVar(op.exportsObjectToken, getExportName(spec.exported)));
                                    break;
                                case "ExportNamespaceSpecifier": // example: export * as x from "m"
                                    a.warnUnsupported(spec); // TODO: ExportNamespaceSpecifier, see https://babeljs.io/docs/en/babel-plugin-proposal-export-namespace-from
                                    break;
                            }

                    }
                    break;
                case "ExportAllDeclaration": // example: export * from "m"
                    const m = op.requireModule(path.node.source.value, a.varProducer.nodeVar(path.node), path);
                    if (m instanceof ModuleInfo) {
                        const t = a.canonicalizeToken(new NativeObjectToken("exports", m));
                        solver.addForAllObjectPropertiesConstraint(t, TokenListener.EXPORT_BASE, path.node, (prop: string) => { // TODO: only exporting explicitly defined properties, not unknown computed
                            solver.addSubsetConstraint(a.varProducer.objPropVar(t, prop), a.varProducer.objPropVar(op.exportsObjectToken, prop));
                        });
                    }
                    break;
            }
        },

        ForOfStatement(path: NodePath<ForOfStatement>) {
            // read iterator using path.node for the temporary result
            op.readIteratorValue(op.expVar(path.node.right, path), a.varProducer.nodeVar(path.node), path.node);
            // assign the temporary result to the l-value
            const lval = isLVal(path.node.left) ? path.node.left : path.node.left.declarations.length === 1 ? path.node.left.declarations[0]?.id : undefined;
            assert(lval, "Unexpected number of declarations at for-of");
            op.assign(a.varProducer.nodeVar(path.node), lval, path.node, a.getEnclosingFunctionOrModule(path, op.moduleInfo), path, false);
            // note: 'for await' is handled trivially because the same abstract object is used for the AsyncGenerator and the iterator objects
        },

        YieldExpression(path: NodePath<YieldExpression>) {
            const fun = path.getFunctionParent()?.node;
            assert(fun, "yield not in function?!");
            const iter = a.canonicalizeToken(new AllocationSiteToken("Iterator", fun.body, op.packageInfo));
            const iterValue = a.varProducer.objPropVar(iter, "value");
            if (path.node.argument) {
                if (path.node.delegate) {
                    // yield* E
                    // constraint: ∀ i2 ∈ ⟦iterators(E)⟧: ⟦i2.value⟧ ⊆ ⟦i.value⟧ where i is the iterator object for the function
                    op.readIteratorValue(op.expVar(path.node.argument, path), iterValue, fun.body);
                } else {
                    // yield E
                    // constraint: ⟦E⟧ ⊆ ⟦i.value⟧ where i is the iterator object for the function
                    solver.addSubsetConstraint(op.expVar(path.node.argument, path), iterValue);
                }
            }
            // constraint: ⟦i.value⟧ ⊆ ⟦yield(*) E⟧ where i is the iterator object for the function
            if (!isParentExpressionStatement(path))
                solver.addSubsetConstraint(iterValue, a.varProducer.nodeVar(path.node));
        },

        AwaitExpression(path: NodePath<AwaitExpression>) {
            op.awaitPromise(op.expVar(path.node.argument, path), op.expVar(path.node, path), path.node);
        },

        TaggedTemplateExpression(path: NodePath<TaggedTemplateExpression>) {
            assert.fail("TaggedTemplateExpression should be handled by @babel/plugin-transform-template-literals");
        },

        RegExpLiteral(path: NodePath<RegExpLiteral>) {
            solver.addTokenConstraint(op.newRegExpToken(), a.varProducer.nodeVar(path.node));
        },

        WithStatement(path: NodePath<WithStatement>) {
            a.warnUnsupported(path.node);
        },

        JSXElement(path: NodePath<JSXElement>) {
            const componentVar = op.expVar(path.node.openingElement.name, path);
            if (componentVar)
                solver.addForAllConstraint(componentVar, TokenListener.JSX_ELEMENT, path.node, (t: Token) => {
                    if (t instanceof AccessPathToken)
                        solver.addAccessPath(a.canonicalizeAccessPath(new ComponentAccessPath(componentVar)), a.varProducer.nodeVar(path.node), t.ap);
                });
        }
    });

    /**
     * Visits a CallExpression, OptionalCallExpression, or NewExpression.
     */
    function visitCallOrNew(isNew: boolean, path: NodePath<CallExpression | OptionalCallExpression | NewExpression>) {
        const calleeVar = isExpression(path.node.callee) ? op.expVar(path.node.callee, path) : undefined;
        const bp = getBaseAndProperty(path);
        const baseVar = bp ? op.expVar(bp.base, path) : undefined;
        const resultVar = op.expVar(path.node, path);
        op.callFunction(calleeVar, baseVar, path.node.arguments, resultVar, isNew, path);
    }

    /**
     * Visits a MemberExpression or OptionalMemberExpression.
     */
    function visitMemberExpression(path: NodePath<MemberExpression | OptionalMemberExpression | JSXMemberExpression>) {
        if (isAssignmentExpression(path.parent) && path.parent.left === path.node)
            return; // don't treat left-hand-sides of assignments as expressions

        op.readProperty(op.expVar(path.node.object, path), getProperty(path.node), isParentExpressionStatement(path) ? undefined : a.varProducer.nodeVar(path.node), path.node, a.getEnclosingFunctionOrModule(path, op.moduleInfo));
    }
}
