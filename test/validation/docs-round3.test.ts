/**
 * ROUND 3 — README.md / GUIDE.md as a defect surface.
 *
 * Round 2 shipped test/validation/docs-truth.test.ts with 22 red tests and
 * changed neither document. This file demonstrates the defects that round 2
 * did NOT cover, plus the one that makes the rest unverifiable: five of the
 * nine adversarial batteries README.md cites as its evidence have never run.
 *
 * Every test here is RED against a *documented sentence*, not against src/.
 *
 * GROUND TRUTH
 *   <scratch>/v27/soroban-env-host-27.0.1/src/budget.rs
 *   <scratch>/core-src/src/ledger/NetworkConfig.cpp
 *   node_modules/@stellar/stellar-sdk (the pinned 16.2.0)
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { rpc, Keypair } from '@stellar/stellar-sdk';
import { LiteStellar, sc, HostFailure } from '../../src/litestellar.js';

const README = readFileSync('README.md', 'utf8');
const GUIDE = readFileSync('GUIDE.md', 'utf8');

const SCRATCH =
  '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad';
const HOST_BUDGET_RS = `${SCRATCH}/v27/soroban-env-host-27.0.1/src/budget.rs`;
const CORE_NETWORK_CONFIG = `${SCRATCH}/core-src/src/ledger/NetworkConfig.cpp`;

const wasm = (n: string) => new Uint8Array(readFileSync(`test/fixtures/${n}`));

// ===========================================================================
// 1. README.md:150-153 — "Found by nine adversarial test batteries ...
//    the red tests in `test/validation/` pin them."
//
//    Five of those nine throw ENOENT at import and collect ZERO tests. They
//    resolve fixtures against `./fixtures/` relative to their own directory
//    (test/validation/fixtures/), a path that has never existed in this repo's
//    git history. `npm run test:validation` reports them inside a "21 failed"
//    file count, so the failure reads as red-by-design rather than as dead code.
// ===========================================================================
describe('README.md:150 — the nine batteries that "pin" Known gaps', () => {
  /** battery -> the README claim it is the sole evidence for */
  const DEAD: [file: string, backs: string][] = [
    [
      'conformance-upstream.test.ts',
      'README.md:41-44 "byte-identical ... nine exact expect![] values reproduced"',
    ],
    [
      'differential.test.ts',
      'README.md:82-84 "byte-identical to the real node ... footprints, return ScVals, contract events, recorded auth"',
    ],
    ['limits-errors.test.ts', 'README.md:93 "nine HostError variants reachable and distinguishable"'],
    ['events-crosscontract.test.ts', 'README.md:88-90 "real cross-contract calls"'],
    ['rpc-surface.test.ts', 'README.md:172 "the surface is complete ... all 18 rpc.Server methods"'],
  ];

  for (const [file, backs] of DEAD) {
    it(`${file} can load the fixtures it imports at module scope`, () => {
      const src = readFileSync(`test/validation/${file}`, 'utf8');

      // The loader every one of these files uses.
      const loader = /new URL\(`(\.[^`$]*)\$\{/.exec(src);
      expect(loader, `precondition: ${file} builds fixture paths with new URL(...)`).not.toBeNull();

      const dir = fileURLToPath(
        new URL(loader![1], `file://${process.cwd()}/test/validation/${file}`),
      );

      expect(
        existsSync(dir),
        `${file} resolves its wasm fixtures to "${dir}", which does not exist ` +
          `(the blobs live in ${process.cwd()}/test/fixtures/). readFileSync runs at ` +
          `module scope, so the file throws ENOENT during collection and contributes ` +
          `0 tests. README.md:150-153 presents it as pinning a Known gap, and it is ` +
          `the only evidence offered for ${backs}. ` +
          `Fix: "../fixtures/". This has been broken since the initial commit.`,
      ).toBe(true);
    });
  }

  // NOTE: deliberately no "run the whole validation suite and count" test here —
  // this file lives in test/validation/, so spawning that suite recurses into
  // itself. The five static checks above prove the ENOENT without recursing.
  // Reproduce manually with:
  //   npm run test:validation 2>&1 | grep '(0 test)'
});

// ===========================================================================
// 2. README.md:53-55 — "`soroban-env-host`'s `Budget::default()` is
//    byte-for-byte stellar-core's `initialCpuCostParamsEntryForV20`"
//    and README.md:156 — "Cost calibration defaults to protocol-20".
//
//    Both are wrong, and the README already contradicts itself: line 159 uses
//    41,142 for VmCachedInstantiation, which is core's *V21* value.
// ===========================================================================
describe.skipIf(!existsSync(CORE_NETWORK_CONFIG) || !existsSync(HOST_BUDGET_RS))(
  'README.md:53 — "byte-for-byte ... initialCpuCostParamsEntryForV20"',
  () => {
    const core = () => readFileSync(CORE_NETWORK_CONFIG, 'utf8');
    const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b));
    const ENTRY =
      /case (\w+):\s*(?:cpuParams|params)\[val\]\s*=\s*ContractCostParamEntry\{ExtensionPoint\{0\},\s*(\d+),\s*(\d+)\}/g;
    const parse = (s: string) => {
      const out: Record<string, [number, number]> = {};
      for (const m of s.matchAll(ENTRY)) out[m[1]] = [Number(m[2]), Number(m[3])];
      return out;
    };
    const hostCpu = () => {
      const src = readFileSync(HOST_BUDGET_RS, 'utf8');
      const out: Record<string, [number, number]> = {};
      const re =
        /ContractCostType::(\w+) => \{\s*cpu\.const_term = (\d+);\s*cpu\.lin_term = ScaledU64\((\d+)\)/g;
      for (const m of src.matchAll(re)) out[m[1]] = [Number(m[2]), Number(m[3])];
      return out;
    };

    it('the host default equals core V20 on the entries they share', () => {
      const c = core();
      const v20 = parse(between(c, 'initialCpuCostParamsEntryForV20()', 'updateCpuCostParamsEntryForV21'));
      const host = hostCpu();

      const differ = Object.keys(host).filter((k) => k in v20 && String(host[k]) !== String(v20[k]));

      expect(
        differ,
        `README.md:53-55 calls Budget::default() "byte-for-byte" core's ` +
          `initialCpuCostParamsEntryForV20. It is not. ` +
          differ
            .map((k) => `${k}: host=(${host[k]}) coreV20=(${v20[k]})`)
            .join('; ') +
          `. (41142, 634) is core's V21 value, set by updateCpuCostParamsEntryForV21 ` +
          `at NetworkConfig.cpp:368. README.md:159 itself quotes 41,142 as the ` +
          `harness's VmCachedInstantiation, so the two halves of this README ` +
          `disagree. README.md:156 "Cost calibration defaults to protocol-20" is ` +
          `wrong for the same reason: the default is a protocol-21 table.`,
      ).toEqual([]);
    });

    it('core V20 covers the cost types the "byte-for-byte" claim ranges over', () => {
      const c = core();
      const v20 = parse(between(c, 'initialCpuCostParamsEntryForV20()', 'updateCpuCostParamsEntryForV21'));
      const host = hostCpu();
      const absent = Object.keys(host).filter((k) => !(k in v20));

      expect(
        absent.length,
        `initialCpuCostParamsEntryForV20 defines ${Object.keys(v20).length} CPU cost ` +
          `types; Budget::default() defines ${Object.keys(host).length}. ` +
          `${absent.length} host entries have no V20 counterpart at all, so ` +
          `"byte-for-byte stellar-core's initialCpuCostParamsEntryForV20" cannot ` +
          `describe the table README.md:56 then counts as "86 CPU cost entries".`,
      ).toBe(0);
    });
  },
);

// ===========================================================================
// 3. README.md:119-125 and GUIDE.md:358-365 both print withFeeCharging(false)
//    inside the escape-hatch list and then close with
//        .withoutClassicChecks();   // all of the above
//    It is not all of the above: fee charging stays on.
//
//    guide.test.ts:240-248 "executes" this snippet but only asserts
//    `toBeInstanceOf(LiteStellar)`, so the executable guide cannot catch it.
// ===========================================================================
describe('withoutClassicChecks() — "all of the above"', () => {
  it('clears every switch the docs list above it, including feeCharging', () => {
    const v = (new LiteStellar().withoutClassicChecks() as any).validation;

    const listedAbove = ['sigverify', 'sequenceCheck', 'feeCharging', 'timebounds'];
    const notCleared = listedAbove.filter((k) => v[k] !== false);

    expect(
      notCleared,
      `README.md:119-125 and GUIDE.md:358-365 list .withFeeCharging(false) among ` +
        `the escape hatches and then annotate .withoutClassicChecks() as ` +
        `"all of the above". After calling it the flags are ` +
        `${JSON.stringify(v)} — ${notCleared.join(', ')} never got set, because ` +
        `src/litestellar.ts:304-306 chains only sigverify, sequenceCheck and ` +
        `timebounds. A test that turns the classic rules off "when a test is not ` +
        `about envelopes" (GUIDE.md:356) still pays fees.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 4. GUIDE.md:277-288 — the worked failure example.
//
//    The guide shows this exact call, then documents `f.errorType` with
//    'Storage' first and offers `f.is(...)` as the predicate to write.
//    The host reports WasmVm/InvalidAction. A reader's Storage check is
//    false forever, silently.
//
//    guide.test.ts:185 asserts only `typeof f.is('Storage') === 'boolean'`,
//    which holds for every possible answer — the executable guide is vacuous here.
// ===========================================================================
describe('GUIDE.md:277 — the failure example', () => {
  it("reports an errorType the guide's own union lists", () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(wasm('contract_data.wasm'));

    let f: HostFailure | undefined;
    try {
      c.invoke('get_persistent', [sc.sym('missing')]); // verbatim GUIDE.md:279
    } catch (e) {
      f = e as HostFailure;
    }
    expect(f).toBeInstanceOf(HostFailure);

    expect(
      f!.errorType,
      `GUIDE.md:282 documents errorType for THIS call as ` +
        `"'Storage' | 'Auth' | 'Budget' | 'WasmVm' | 'Contract' | ..." with Storage ` +
        `first, and GUIDE.md:286 offers f.is(...) as the predicate to write. The ` +
        `host actually reports ${f!.errorType}/${f!.errorCode}: the fixture unwraps, ` +
        `so a missing key surfaces as a trap, not a storage miss. A reader who ` +
        `copies the block and writes f.is('Storage', 'MissingValue') gets ` +
        `${f!.is('Storage', 'MissingValue')} forever with no signal. ` +
        `guide.test.ts:185 only asserts the call returns *a boolean*.`,
    ).toBe('Storage');
  });
});

// ===========================================================================
// 5. README.md:172-175 "all 18 rpc.Server methods" /
//    GUIDE.md:344 "All 18 rpc.Server methods work" — and GUIDE.md:409, which
//    still tells the reader five RPC methods are missing.
// ===========================================================================
describe('the "18 rpc.Server methods" claim', () => {
  const surface = () => {
    const proto: any = rpc.Server.prototype;
    return Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && typeof proto[n] === 'function' && !n.startsWith('_'),
    );
  };

  it('rpc.Server really has 18 public methods', () => {
    const names = surface();
    expect(
      names.length,
      `README.md:172-174 and GUIDE.md:344-348 both say "all 18 rpc.Server methods". ` +
        `The pinned @stellar/stellar-sdk 16.2.0 exposes ${names.length}: ` +
        `${names.sort().join(', ')}. Whatever 18 counted, it is not this surface, ` +
        `so "all 18" cannot mean "all of them".`,
    ).toBe(18);
  });

  it('test/rpc-compat.test.ts calls every rpc.Server method, as README.md:172 claims', () => {
    const src = readFileSync('test/rpc-compat.test.ts', 'utf8');
    const untouched = surface().filter((n) => !new RegExp(`\\.${n}\\s*\\(`).test(src));

    expect(
      untouched,
      `README.md:172-174 says test/rpc-compat.test.ts "calls all 18 rpc.Server ` +
        `methods and checks the SDK-parsed result of each". It never calls these ` +
        `${untouched.length}: ${untouched.join(', ')}.`,
    ).toEqual([]);
  });

  it('GUIDE.md does not still advertise missing RPC methods', () => {
    expect(
      /and five RPC methods/.test(GUIDE),
      `GUIDE.md:409 "What this does not do" still lists "five RPC methods" and ` +
        `sends the reader to README "Known gaps", which now says the opposite ` +
        `(README.md:172 "the surface is complete"). One of the two is stale and a ` +
        `reader cannot tell which.`,
    ).toBe(false);
  });

  it('fundAddress works in process, like the requestAirdrop the docs advertise', async () => {
    const svm = new LiteStellar();
    const server = svm.rpcServer();
    const who = Keypair.random().publicKey();

    let err: unknown;
    try {
      await server.fundAddress(who);
    } catch (e) {
      err = e;
    }

    expect(
      err,
      `GUIDE.md:344-347 says "All 18 rpc.Server methods work ... including ` +
        `requestAirdrop — which funds through an in-process friendbot". ` +
        `requestAirdrop does work. fundAddress — the method the pinned SDK's own ` +
        `docstring tells you to use, and the only one that accepts a C... address ` +
        `— throws: ${String((err as any)?.message ?? err)}. It POSTs to the ` +
        `friendbot and then calls getTransaction(response.data.hash); the ` +
        `in-process friendbot (src/fake-rpc.ts:249-266) funds the account and ` +
        `synthesises meta but never registers the funding as a transaction, so ` +
        `the lookup is NOT_FOUND. Nothing in either document warns about this.`,
    ).toBeUndefined();
  });
});

// ===========================================================================
// 6. README.md:14 — "npm test   # 114 tests, ~840 ms"
// ===========================================================================
describe('README.md:14 — the advertised test count', () => {
  it('matches what the green suite runs', () => {
    const out = execFileSync('npx', ['vitest', 'run', '--reporter=basic'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    }).toString();

    const actual = Number(/Tests\s+(\d+) passed/.exec(out)?.[1]);
    const claimed = Number(/npm test\s+#\s*([\d,]+) tests/.exec(README)?.[1]?.replace(/,/g, ''));

    expect(
      actual,
      `README.md:14 advertises ${claimed} tests; \`npm test\` runs ${actual}.`,
    ).toBe(claimed);
  });
});
