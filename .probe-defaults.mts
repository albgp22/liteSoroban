/**
 * Parse the host's compiled-in Budget::default() tables straight out of
 * soroban-env-host-27.0.1/src/budget.rs and diff them against the shipped
 * protocol-27 table, entry by entry, for BOTH dimensions.
 */
import { readFileSync } from 'node:fs';
import { xdr } from '@stellar/stellar-sdk';
import { PROTOCOL_27_COST_PARAMS } from './src/cost-params.js';

const SRC = '/private/tmp/claude-501/-Users-alberto/8536199a-7797-4de6-9c1f-72ab2e240bed/scratchpad/v27/soroban-env-host-27.0.1/src/budget.rs';
const text = readFileSync(SRC, 'utf8');

function parseBlock(varName: 'cpu' | 'mem') {
  const out = new Map<string, { c: bigint; l: bigint }>();
  const re = new RegExp(
    `ContractCostType::(\\w+)\\s*=>\\s*\\{[^}]*?${varName}\\.const_term\\s*=\\s*([0-9_]+);[^}]*?${varName}\\.lin_term\\s*=\\s*([^;]+);`,
    'gs',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1];
    const c = BigInt(m[2].replace(/_/g, ''));
    const lraw = m[3].trim();
    let l: bigint;
    let mm: RegExpMatchArray | null;
    if ((mm = lraw.match(/^ScaledU64\((\d+)\)$/))) l = BigInt(mm[1]);
    else if ((mm = lraw.match(/^ScaledU64::from_unscaled_u64\((\d+)\)$/))) l = BigInt(mm[1]) * 128n;
    else if ((mm = lraw.match(/^ScaledU64::from_unscaled_u64\((\d+)\)\s*\.safe_div\((\d+)\)$/)))
      l = (BigInt(mm[1]) * 128n) / BigInt(mm[2]);
    else { console.log('  ?? unparsed lin_term for', name, JSON.stringify(lraw)); continue; }
    if (!out.has(name)) out.set(name, { c, l });
  }
  return out;
}

const cpuDef = parseBlock('cpu');
const memDef = parseBlock('mem');
console.log('parsed default entries: cpu', cpuDef.size, 'mem', memDef.size);

const names = Object.keys(xdr.ContractCostType).filter((k) => typeof (xdr.ContractCostType as any)[k] === 'function');
const dec = (b64: string) =>
  xdr.ContractCostParams.fromXDR(Buffer.from(b64, 'base64')).map((e: any) => ({
    c: BigInt(e.constTerm().toString()),
    l: BigInt(e.linearTerm().toString()),
  }));
const cpuNet = dec(PROTOCOL_27_COST_PARAMS.cpuInstructions);
const memNet = dec(PROTOCOL_27_COST_PARAMS.memoryBytes);

function diff(label: string, def: Map<string, { c: bigint; l: bigint }>, net: any[]) {
  let differ = 0, missing = 0;
  const lines: string[] = [];
  net.forEach((n, i) => {
    const camel = names[i];
    const pascal = camel ? camel[0].toUpperCase() + camel.slice(1) : `#${i}`;
    const d = def.get(pascal);
    if (!d) { missing++; return; }
    if (d.c !== n.c || d.l !== n.l) {
      differ++;
      lines.push(`   ${pascal.padEnd(28)} default(${d.c},${d.l})  network(${n.c},${n.l})`);
    }
  });
  console.log(`${label}: ${differ} of ${net.length} entries differ (${missing} names unmatched)`);
  console.log(lines.join('\n'));
}
diff('CPU', cpuDef, cpuNet);
diff('MEM', memDef, memNet);
