import { writeFileSync } from 'node:fs';
import { schemaSql } from '../src/worker/schema';

writeFileSync('migrations/0001_init.sql', schemaSql());
console.log('Wrote migrations/0001_init.sql');
