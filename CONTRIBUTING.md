# Contributing

smsfire is meant to stay **small**: one core object, one gateway module, one store interface. Before proposing a feature, read the non-goals in the README. Prefer fewer files, fewer abstractions, no dependencies.

```bash
npm install
npm run verify   # typecheck, build, tests, bundle-size check, universal-runtime check
```

- Main entry must stay universal: no `node:` imports, `Buffer`, or unguarded `process`.
- Zero runtime dependencies. `express`, `mongoose` and `react` must never be imported by the package.
- Tests use a scriptable fake gateway (`tests/fake-gateway.ts`). MongoDB tests run only when `MONGODB_URI` is set.
- Manual real-phone check: `SMSFIRE_URL=... SMSFIRE_TOKEN=... SMOKE_TO=+92... node scripts/smoke.mjs`.
