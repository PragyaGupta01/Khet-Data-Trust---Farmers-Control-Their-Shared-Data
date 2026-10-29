import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { createStore } from './core';

const dbPath = process.env.DB_PATH || 'data/khet.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const port = Number(process.env.PORT || 3000);
createApp(createStore(dbPath)).listen(port, () => console.log(`Khet Data Trust (synthetic demo) on http://localhost:${port}`));
