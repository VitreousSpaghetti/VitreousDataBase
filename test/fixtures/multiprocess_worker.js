'use strict';
// Child process for test/multiprocess.test.js. Args: <dbPath> <workerId> <count>
const { Database } = require('../../index');

(async () => {
  const [dbPath, worker, count] = process.argv.slice(2);
  const db = await Database.create(dbPath, { multiProcess: true, lockTimeout: 30000 });
  const rm = db.recordManager;
  for (let i = 0; i < Number(count); i++) {
    const n = `${worker}-${i}`;
    await rm.insert('items', { n });
    await rm.insert('bag', { n });
    // shared shards (r0..r2) + one shard per worker created concurrently
    await rm.insert('geo', { region: `r${i % 3}`, n });
    await rm.insert('geo', { region: `w${worker}`, n });
  }
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
