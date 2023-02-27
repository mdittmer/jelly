#!/usr/bin/env node

import {join} from "path";

import {analyzeFiles, expandSourceFiles, setOptions, Solver} from "./lib";

const seedFiles = [
    "examples/aws-bookstore-demo-app/aws-bookstore-demo-app/functions/APIs/addToCart.js",
];

setOptions({
    basdir: join(__dirname, ".."), // /path/to/jelly/(lib|src)/..
    loglevel: "debug",
    variableKinds: true,
});

(async () => {
    const files = expandSourceFiles(seedFiles);
    const solver = new Solver();
    // const a = solver.analysisState;
    await analyzeFiles(files, solver);
    const f = solver.fragmentState;

    const kinds = new Set();
    for (const [v, _, __] of f.getAllVarsAndTokens()) {
        kinds.add(v.getKind());
    }

    const sortedKinds = Array.from(kinds);
    sortedKinds.sort();

    console.log("Kinds:");
    for (const kind of sortedKinds) {
        console.log(`    ${kind}`);
    }
})();
