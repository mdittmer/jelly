# Notes about stuff I've tried

## Shell invocations

After `npm link` to get `jelly` (uncompiled):

```bash
NODE_OPTIONS='--huge-max-old-generation-size --max-old-space-size=16384 --max-semi-space-size=16384' jelly lib/main.js --basedir examples/aws-bookstore-demo-app --logfile tmp/aws-bookstore-demo-app.log --loglevel debug --dataflow-html tmp/dataflow__aws-bookstore-demo-app.html --callgraph-html tmp/callgraph__aws-bookstore-demo-app.html --callgraph-json tmp/callgraph__aws-bookstore-demo-app.json --tokens-json tmp/tokens__aws-bookstore-demo-app.json --tokens --largest --warnings-unsupported --typescript --api-exported --higher-order-functions --zeros --tracked-modules '**' --diagnostics --diagnostics-json tmp/diagnostics__aws-bookstore-demo-app.json --variable-kinds examples/aws-bookstore-demo-app/aws-bookstore-demo-app/functions/APIs/addToCart.js
```

Similarly, after `npm run pkg`--which takes minutes--to get precompiled binary (invocation takes >6 minutes):

```bash
dist/@cs-au-dk/jelly-linux --basedir examples/aws-bookstore-demo-app --logfile tmp/aws-bookstore-demo-app.log --loglevel debug --dataflow-html tmp/dataflow__aws-bookstore-demo-app.html --callgraph-html tmp/callgraph__aws-bookstore-demo-app.html --callgraph-json tmp/callgraph__aws-bookstore-demo-app.json --tokens-json tmp/tokens__aws-bookstore-demo-app.json --tokens --largest --warnings-unsupported --typescript --api-exported --higher-order-functions --zeros --tracked-modules '**' --diagnostics --diagnostics-json tmp/diagnostics__aws-bookstore-demo-app.json --variable-kinds examples/aws-bookstore-demo-app/aws-bookstore-demo-app/functions/APIs/addToCart.js
```

Messing around with small programs:

```bash
jelly --dataflow-html tmp/dataflow__sandbox.html examples/micro/sandbox.ts
```

Manually package "sandbox" entry point for experimentation with long-running invocations:

```bash
npm run clean && npm run build && pkg lib/sandbox.js -C Brotli --options \"expose-gc,huge-max-old-generation-size,max-old-space-size=16384,max-semi-space-size=16384\" -c package.json --out-path dist
```
