/**
 * DOCUMENTATION TRUTH — README.md and GUIDE.md as a defect surface.
 *
 * Every test here checks a *claim the docs make*, against ground truth or
 * against running code. A red test is a false or unverifiable sentence in a
 * shipped document, not a bug in src/.
 *
 * GROUND TRUTH USED
 *   <scratch>/v27/soroban-env-host-27.0.1/src/budget.rs
 *   <scratch>/core-src/src/ledger/NetworkConfig.cpp
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { xdr } from '@stellar/stellar-sdk';
import { LiteStellar, sc } from '../../src/litestellar.js';
import { uploadWasmHostFn } from '../../src/index.js';

const README = readFileSync('README.md', 'utf8');
const GUIDE = readFileSync('GUIDE.md', 'utf8');
const GUIDE_TEST = readFileSync('test/guide.test.ts', 'utf8');

const SCRATCH =
  '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad';
const HOST_BUDGET_RS = `${SCRATCH}/v27/soroban-env-host-27.0.1/src/budget.rs`;
const CORE_NETWORK_CONFIG = `${SCRATCH}/core-src/src/ledger/NetworkConfig.cpp`;

const wasm = (n: string) => new Uint8Array(readFileSync(`test/fixtures/${n}`));

// ===========================================================================
// 1. "every snippet in it is executed by test/guide.test.ts, so it cannot rot"
//    (README.md:18-19, GUIDE.md:3)
// ===========================================================================
describe('GUIDE.md: "Every snippet below is executed by test/guide.test.ts"', () => {
  /**
   * (section, an API symbol that appears ONLY in that section's snippet).
   * If guide.test.ts never mentions the symbol it cannot be executing the
   * snippet, so the sentence at the top of GUIDE.md is false for it.
   */
  const SNIPPET_MARKERS: [section: string, symbol: string][] = [
    ['Tokens you do not issue — adopt the issuer', 'adoptAccount'],
    ['Tokens you do not issue — SAC for a foreign asset', 'deployTokenFor'],
    ['Tokens you do not issue — mainnet contract id', 'Networks.PUBLIC'],
    ['Tokens you do not issue — write the trustline', 'establishTrustline'],
    ['Deploying through a factory', 'get_deployed_address'],
    ['Asserting on resources — read a live table', 'loadCostParamsFromRpc'],
    ['Dropping to the low level — setEntry', 'setEntry'],
    ['Dropping to the low level — simulateWithAuth', 'simulateWithAuth'],
    ['Tokens — unauthorized trustline', 'authorized: false'],
  ];

  for (const [section, symbol] of SNIPPET_MARKERS) {
    it(`"${section}" is executed (guide.test.ts mentions ${symbol})`, () => {
      expect(GUIDE.includes(symbol), `precondition: GUIDE.md contains ${symbol}`).toBe(true);
      expect(
        GUIDE_TEST.includes(symbol),
        `GUIDE.md:3 claims every snippet is executed by test/guide.test.ts, but ` +
          `that file never mentions \`${symbol}\`, so the "${section}" snippet is ` +
          `not executed and can rot silently.`,
      ).toBe(true);
    });
  }

  /**
   * The factory snippet is not merely unexecuted — it does not compile. It
   * builds `args` and then passes a never-declared `ctorArgs` to
   * get_deployed_address. test/factory.test.ts declares `ctorArgs`; the guide
   * dropped the declaration when the code was copied across.
   */
  it('the factory snippet declares every identifier it uses', () => {
    const block = GUIDE.slice(
      GUIDE.indexOf('const factory = svm.deployContract(FACTORY_WASM)'),
      GUIDE.indexOf('Also covered by `test/factory.test.ts`'),
    );
    expect(block.length, 'precondition: factory snippet found').toBeGreaterThan(0);
    expect(/\bctorArgs\b/.test(block), 'precondition: the snippet uses ctorArgs').toBe(true);
    expect(
      /(?:const|let|var)\s+ctorArgs\b/.test(block),
      'GUIDE.md "Deploying through a factory" passes `ctorArgs` to ' +
        'get_deployed_address but never declares it (it declares `args`). The ' +
        'snippet is a ReferenceError as written, and test/guide.test.ts does not ' +
        'run it, so nothing catches this.',
    ).toBe(true);
  });

  /**
   * Same class of defect in the passkey snippet: `signerFor` and `newSigner`
   * are used and never shown. They are the ONE thing a reader cannot guess —
   * the guide claims the shipped builders "target the Crossmint smart-account
   * shape" but never shows that shape anywhere.
   */
  it('the passkey snippet shows how to build a signer ScVal', () => {
    const block = GUIDE.slice(
      GUIDE.indexOf('const passkey = createP256Signer()'),
      GUIDE.indexOf('`signAuth` takes any'),
    );
    expect(block.length, 'precondition: passkey snippet found').toBeGreaterThan(0);
    const undeclared = ['signerFor', 'newSigner'].filter(
      (id) =>
        new RegExp(`\\b${id}\\b`).test(block) &&
        !new RegExp(`(?:const|let|var|function)\\s+${id}\\b`).test(block),
    );
    expect(
      undeclared,
      'GUIDE.md "Custom accounts and passkeys" uses these identifiers without ' +
        'ever defining them, and the guide never shows the signer ScVal shape ' +
        'the Crossmint smart account expects. A reader following the guide ' +
        'cannot construct one.',
    ).toEqual([]);
  });
});

// ===========================================================================
// 2. "npm test  # 114 tests, ~840 ms"  (README.md:14)
// ===========================================================================
describe('README.md: the advertised test count', () => {
  it('matches what `npm test` actually runs', () => {
    const claimed = Number(README.match(/npm test\s+#\s*([\d,]+) tests/)![1].replace(/,/g, ''));
    // vitest.config.ts includes only test/*.test.ts, so this file is not in it.
    const out = execFileSync('npx', ['vitest', 'run', '--reporter=basic'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = out.match(/Tests\s+(?:\d+ failed \| )?(\d+) passed\s+\((\d+)\)/);
    expect(m, `could not parse the vitest summary:\n${out.slice(-800)}`).toBeTruthy();
    const actual = Number(m![2]);
    expect(
      claimed,
      `README.md:14 advertises "${claimed} tests"; the green suite runs ${actual}.`,
    ).toBe(actual);
  }, 120_000);
});

// ===========================================================================
// 3. "Found by nine adversarial test batteries ... the red tests in
//     test/validation/ pin them"  (README.md:152-153)
// ===========================================================================
describe('README.md: the validation batteries that back "Known gaps"', () => {
  /**
   * conformance-upstream, differential, limits-errors, events-crosscontract and
   * rpc-surface all resolve their wasm fixtures against `./fixtures/` — i.e.
   * test/validation/fixtures/ — which does not exist. The blobs live in
   * test/fixtures/. All five throw ENOENT at import time and contribute zero
   * tests to `npm run test:validation`.
   *
   * That matters most for conformance-upstream.test.ts: it is the only place
   * the 1,767,593 / e2e_tests.rs:894 conformance README.md:44 calls "**True.**"
   * is ever checked. (Repairing the path by hand shows the numbers DO reproduce
   * — so the claim is true, but nothing in the shipped repo verifies it.)
   */
  const BATTERIES = [
    'conformance-upstream',
    'differential',
    'limits-errors',
    'events-crosscontract',
    'rpc-surface',
  ];

  for (const name of BATTERIES) {
    it(`test/validation/${name}.test.ts can resolve its fixtures`, () => {
      const src = readFileSync(`test/validation/${name}.test.ts`, 'utf8');
      const refs = [...src.matchAll(/new URL\(`(\.[^`$]*)\$\{/g)].map((m) => m[1]);
      expect(refs.length, 'precondition: file loads fixtures by URL').toBeGreaterThan(0);
      for (const ref of refs) {
        const dir = `test/validation/${ref}`.replace(/\/+$/, '');
        expect(
          existsSync(dir),
          `${name}.test.ts resolves fixtures against "${ref}" (=> ${dir}/), which ` +
            `does not exist — the blobs are in test/fixtures/. The file throws ` +
            `ENOENT at import and runs 0 tests, so the gaps README.md:152 says it ` +
            `pins are not pinned by anything.`,
        ).toBe(true);
      }
    });
  }

  it('every battery in test/validation/ collects', () => {
    const broken = new Set<string>();
    for (const f of readdirSync('test/validation')) {
      if (!f.endsWith('.test.ts') || f === 'docs-truth.test.ts') continue;
      const src = readFileSync(`test/validation/${f}`, 'utf8');
      for (const m of src.matchAll(/new URL\(`(\.[^`$]*)\$\{/g)) {
        if (!existsSync(`test/validation/${m[1]}`.replace(/\/+$/, ''))) broken.add(f);
      }
    }
    expect(
      [...broken].sort(),
      'README.md:152 credits "nine adversarial test batteries"; these files fail ' +
        'to import and contribute zero tests.',
    ).toEqual([]);
  });
});

// ===========================================================================
// 4. "soroban-env-host's Budget::default() is byte-for-byte stellar-core's
//     initialCpuCostParamsEntryForV20"
//    (README.md:53-55, README.md:156, src/cost-params.ts:4-5)
// ===========================================================================
describe.skipIf(!existsSync(CORE_NETWORK_CONFIG) || !existsSync(HOST_BUDGET_RS))(
  'README.md: what the host default calibration actually is',
  () => {
    it('Budget::default() == initialCpuCostParamsEntryForV20 (VmCachedInstantiation)', () => {
      const core = readFileSync(CORE_NETWORK_CONFIG, 'utf8');
      const v20 = core.slice(
        core.indexOf('initialCpuCostParamsEntryForV20()'),
        core.indexOf('updateCpuCostParamsEntryForV21'),
      );
      const coreVmCached = v20
        .match(
          /case VmCachedInstantiation:[\s\S]*?ContractCostParamEntry\{ExtensionPoint\{0\},\s*(\d+),\s*(\d+)\}/,
        )!
        .slice(1, 3)
        .map(Number);

      const host = readFileSync(HOST_BUDGET_RS, 'utf8');
      const hostVmCached = host
        .match(
          /ContractCostType::VmCachedInstantiation => \{\s*cpu\.const_term = (\d+);\s*cpu\.lin_term = ScaledU64\((\d+)\)/,
        )!
        .slice(1, 3)
        .map(Number);

      expect(
        hostVmCached,
        `README.md:53 and src/cost-params.ts:4 say Budget::default() is ` +
          `"byte-for-byte" initialCpuCostParamsEntryForV20. It is not: core's V20 ` +
          `entry has VmCachedInstantiation = (${coreVmCached.join(', ')}) and defines ` +
          `only 23 of the 86 cost types, while the host default has ` +
          `(${hostVmCached.join(', ')}) — core's V21 value, set by ` +
          `updateCpuCostParamsEntryForV21. Calling the default "protocol-20" ` +
          `(README.md:156, "Cost calibration defaults to protocol-20") is wrong ` +
          `for the same reason.`,
      ).toEqual(coreVmCached);
    });
  },
);

// ===========================================================================
// 5. "The residual ~1.4% on upload is not calibration: it is the AccountEntry
//     extension chain and the missing module cache"  (README.md:79-80)
// ===========================================================================
describe('README.md: the 1.4% upload residual', () => {
  /**
   * The "real node" column of the README table (1,547,805) was measured by
   * differential.test.ts, which uploads `uniquifyWasm(ADD_I32)` — the 582-byte
   * fixture plus a 27-byte custom section. cost-params.test.ts then compares
   * that reference against the in-process count for the *plain* 582-byte blob.
   *
   * The residual is those 27 bytes. Metering the same 609 bytes the node
   * metered reproduces 1,547,805 exactly, with the AccountEntry chain and the
   * module cache untouched — and an upload reads no account entry at all
   * (disk_read_bytes 0, e2e_tests.rs:897).
   */
  it('disappears when both sides meter the same wasm bytes', () => {
    const NODE_UPLOAD = 1_547_805; // test/cost-params.test.ts:25, README.md:62
    const plain = wasm('add_i32.wasm');

    // exactly differential.test.ts:137 uniquifyWasm()
    const tag = new Uint8Array(16);
    crypto.getRandomValues(tag);
    const name = Buffer.from('difftest', 'ascii');
    const payload = Buffer.concat([Buffer.from([name.length]), name, Buffer.from(tag)]);
    const uniq = new Uint8Array(
      Buffer.concat([Buffer.from(plain), Buffer.from([0x00, payload.length]), payload]),
    );
    expect(plain.length).toBe(582);
    expect(uniq.length).toBe(609);

    const svm = new LiteStellar().withNetworkCostParams();
    const src = svm.payer.accountIdB64;
    const plainInsns = svm.ledger.simulate(uploadWasmHostFn(plain), src).instructions;
    const uniqInsns = svm.ledger.simulate(uploadWasmHostFn(uniq), src).instructions;
    const pct = (n: number) => ((n - NODE_UPLOAD) / NODE_UPLOAD) * 100;

    // PROOF: on the bytes the node actually metered, the harness is exact.
    expect(
      uniqInsns,
      'like-for-like the harness should reproduce the node exactly',
    ).toBe(NODE_UPLOAD);
    // and the whole "1.4%" is the 27-byte difference
    expect(Math.abs(pct(plainInsns))).toBeCloseTo(1.41, 2);

    expect(
      README.includes('The residual ~1.4% on upload is not calibration'),
      `README.md:79 attributes the ~1.4% upload residual to "the AccountEntry ` +
        `extension chain and the missing module cache". Neither is involved: an ` +
        `upload reads no account entry (disk_read_bytes 0). The node figure ` +
        `${NODE_UPLOAD} was measured on a 609-byte blob — differential.test.ts ` +
        `uniquifies the wasm — while cost-params.test.ts compares it against the ` +
        `582-byte fixture (${plainInsns}, ${pct(plainInsns).toFixed(2)}%). On the ` +
        `same 609 bytes this harness returns ${uniqInsns}: 0.00%. The residual is ` +
        `a benchmark bookkeeping error, not a fidelity gap.`,
    ).toBe(false);
  });
});

// ===========================================================================
// 6. README "the surface is complete" vs GUIDE "and five RPC methods"
//    (README.md:172 vs GUIDE.md:409)
// ===========================================================================
describe('README.md and GUIDE.md agree about the RPC surface', () => {
  it('GUIDE.md does not still list RPC methods as missing', () => {
    expect(
      /\*\*RPC facade\*\* — the surface is complete/.test(README),
      'precondition: README claims the surface is complete',
    ).toBe(true);
    expect(
      /and five RPC methods/.test(GUIDE),
      'GUIDE.md "What this does not do" still says "and five RPC methods" and ' +
        'sends the reader to README "Known gaps" — which now says the opposite ' +
        '("the surface is complete ... all 18 rpc.Server methods"). The code ' +
        'agrees with README, so GUIDE.md is the stale one.',
    ).toBe(false);
  });
});

// ===========================================================================
// 7. GUIDE "Asserting on failures": the worked example's real error
//    (GUIDE.md:277-288)
// ===========================================================================
describe('GUIDE.md: the failure example reports the type the guide implies', () => {
  /**
   * The guide's example is `c.invoke('get_persistent', [sc.sym('missing')])`
   * and the next line enumerates `'Storage' | 'Auth' | ...` with Storage first.
   * The call actually yields WasmVm/InvalidAction, because the fixture unwraps.
   * guide.test.ts:185 only asserts that `is('Storage')` returns *a boolean* —
   * true for every possible answer — so it cannot catch this.
   */
  it("the guide's own is('Storage', ...) reads true on its worked example", () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(wasm('contract_data.wasm'));
    const r = c.tryInvoke('get_persistent', [sc.sym('missing')]);
    expect(r.ok).toBe(false);
    expect(
      r.error!.is('Storage'),
      `GUIDE.md:279-283 shows exactly this call and then documents ` +
        `f.errorType with 'Storage' listed first and f.is('Storage', ...) as the ` +
        `predicate to use. The host actually reports ` +
        `${r.error!.errorType}/${r.error!.errorCode} — the fixture unwraps, so ` +
        `the storage miss surfaces as a trap. A reader copying the block writes a ` +
        `check that silently never matches. The executable guide cannot catch ` +
        `this: guide.test.ts:185 only asserts that is('Storage') returns *a ` +
        `boolean*, which holds for every possible answer.`,
    ).toBe(true);
  });
});

// ===========================================================================
// 8. Claims that DO hold — pinned so a future edit cannot quietly break them.
// ===========================================================================
describe('README.md claims that are true (pinned)', () => {
  it.skipIf(!existsSync(HOST_BUDGET_RS))(
    '18 of 86 CPU cost entries differ, dominated by ValDeser 59,052 vs 331',
    () => {
      const src = readFileSync(HOST_BUDGET_RS, 'utf8');
      const scaled = (e: string) => {
        let m = e.match(/^ScaledU64\((\d+)\)$/);
        if (m) return Number(m[1]);
        m = e.match(/^ScaledU64::from_unscaled_u64\((\d+)\)$/);
        if (m) return Number(m[1]) * 128;
        m = e.match(/^ScaledU64::from_unscaled_u64\((\d+)\)\.safe_div\((\d+)\)$/);
        if (m) return Math.floor((Number(m[1]) * 128) / Number(m[2]));
        throw new Error(`unparsed ScaledU64: ${e}`);
      };
      const host: Record<string, [number, number]> = {};
      for (const m of src.matchAll(
        /ContractCostType::(\w+) => \{\s*cpu\.const_term = (\d+);\s*cpu\.lin_term = ([^;]+);/g,
      )) {
        host[m[1].toLowerCase()] = [Number(m[2]), scaled(m[3].trim())];
      }

      const table = JSON.parse(readFileSync('src/costparams/protocol27.json', 'utf8'));
      const params = xdr.ContractCostParams.fromXDR(
        Buffer.from(table.cpuInstructions, 'base64'),
      ) as any[];
      const names = xdr.ContractCostType.values().map((v: any) => v.name.toLowerCase());

      expect(params.length).toBe(86);
      let differing = 0;
      for (let i = 0; i < names.length; i++) {
        const h = host[names[i]];
        const n = [
          Number(params[i].constTerm().toString()),
          Number(params[i].linearTerm().toString()),
        ];
        if (h[0] !== n[0] || h[1] !== n[1]) differing++;
      }
      expect(differing).toBe(18);
      expect(host['valdeser'][0]).toBe(59052);
      expect(Number(params[7].constTerm().toString())).toBe(331);
      // and the entry the "protocol-20" story would require to differ, does not
      expect(host['vmcachedinstantiation']).toEqual([41142, 634]);
    },
  );

  it("'accountId' in someScAddress is always true", () => {
    const svm = new LiteStellar();
    const c = svm.deployContract(wasm('add_i32.wasm'));
    expect(c.address.switch().name).toBe('scAddressTypeContract');
    expect('accountId' in c.address).toBe(true);
  });

  it('an unsorted ScMap is rejected with Error(Object, InvalidInput)', () => {
    const svm = new LiteStellar();
    const factory = svm.deployContract(wasm('contract_factory.wasm'));
    const hash = svm.addContract(wasm('contract_data.wasm'));
    const fields = [
      { key: sc.sym('constructor_args'), val: sc.vec([]) },
      { key: sc.sym('salt'), val: sc.bytes(Buffer.alloc(32, 3)) },
      { key: sc.sym('wasm_hash'), val: sc.bytes(Buffer.from(hash, 'base64')) },
    ];
    expect(factory.tryInvoke('deploy', [sc.map(fields)]).ok).toBe(true);
    const bad = factory.tryInvoke('deploy', [sc.map([fields[2], fields[0], fields[1]])]);
    expect(bad.ok).toBe(false);
    expect(`${bad.error!.errorType}/${bad.error!.errorCode}`).toBe('Object/InvalidInput');
  });
});
