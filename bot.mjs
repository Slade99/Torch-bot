import { ethers } from 'ethers';
import fs from 'fs';

const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0x7891eA889899928aFE637e4Cca8106188427776a';
const TG = process.env.TG_TOKEN, CHAT = process.env.TG_CHAT;
const STEP = +(process.env.STEP || 1000);          // blocks per getLogs call
const MAX_BACKFILL = 300000;                        // never scan further back than this
const ONCE = process.env.RUN_ONCE === '1';          // for GitHub Actions
const STATE = 'last_block.txt';

const EVENT = 'event TokenLaunched(address indexed token, address indexed creator, bytes32 poolId, uint256 buyTaxBps, uint24 lpFee, uint256 antiSnipeSeconds, tuple(uint16 creatorBps, uint16 burnBps, uint16 holdersBps, uint16 liquidityBps) split, string contractURI, address quote)';

const iface = new ethers.Interface([EVENT]);
const TOPIC = iface.fragments[0].topicHash;
const p = new ethers.JsonRpcProvider(RPC);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = bps => (Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '') + '%';

async function meta(addr) {
  try {
    const c = new ethers.Contract(addr, [
      'function name() view returns (string)',
      'function symbol() view returns (string)'
    ], p);
    const [n, s] = await Promise.all([c.name(), c.symbol()]);
    return { n: String(n).slice(0, 80), s: String(s).slice(0, 30) };
  } catch { return { n: '?', s: '?' }; }
}

async function send(text) {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    if (r.ok) return;
    const body = await r.text();
    console.error('telegram', r.status, body);
    if (r.status === 429) { await sleep(((JSON.parse(body).parameters?.retry_after) || 5) * 1000); continue; }
    return;
  }
}

async function format(parsed) {
  const [token, creator, poolId, taxBps, lpFee, anti, split, uri, quote] = parsed.args;
  const m = await meta(token);
  let quoteName = 'ETH';
  if (quote !== ethers.ZeroAddress) quoteName = (await meta(quote)).s;

  return (
    `🔥 <b>${esc(m.n)}</b> ($${esc(m.s)})\n` +
    `CA: <code>${token}</code>\n` +
    `Dev: <code>${creator}</code>\n\n` +
    `💱 Pair: ${esc(quoteName)}\n` +
    `🧾 Buy tax: ${pct(taxBps)}\n` +
    `🏊 LP fee: ${(Number(lpFee) / 10000).toFixed(2).replace(/\.?0+$/, '')}%\n` +
    `🛡 Anti-snipe: ${anti.toString()}s\n` +
    `🔀 Tax split: creator ${pct(split[0])} | burn ${pct(split[1])} | holders ${pct(split[2])} | liquidity ${pct(split[3])}\n\n` +
    `📈 <a href="https://app.torchpad.fun/trade/robinhood/${token}">Trade on Torch</a>\n` +
    `🔎 <a href="https://robinhoodchain.blockscout.com/token/${token}">Explorer</a>`
  );
}

let from = fs.existsSync(STATE) ? +fs.readFileSync(STATE, 'utf8') : await p.getBlockNumber();

async function tick() {
  const head = await p.getBlockNumber();
  if (head - from > MAX_BACKFILL) from = head - MAX_BACKFILL;
  while (from <= head) {
    const to = Math.min(head, from + STEP - 1);
    const logs = await p.getLogs({ address: FACTORY, fromBlock: from, toBlock: to, topics: [TOPIC] });
    for (const l of logs) {
      try {
        const parsed = iface.parseLog({ topics: l.topics, data: l.data });
        await send(await format(parsed));
      } catch (e) { console.error('decode', e.message); }
      await sleep(1100);
    }
    from = to + 1;
    fs.writeFileSync(STATE, String(from));
    await sleep(300);
  }
}

if (ONCE) { await tick(); process.exit(0); }
for (;;) {
  try { await tick(); } catch (e) { console.error(e.message); await sleep(3000); }
  await sleep(2500);
}