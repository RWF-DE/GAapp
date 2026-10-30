import { z } from 'zod';
const dt = z.iso.datetime({ offset: true });
for (const s of ['2026-09-15T03:34:56.123456+00:00','2026-09-15T12:34:56+09:00','2026-09-15T03:34:56Z']) console.log(s, dt.safeParse(s).success);
console.log('uuid zero', z.uuid().safeParse('00000000-0000-0000-0000-000000000001').success, z.uuid().safeParse('00000000-0000-4000-8000-0000000000a1').success);
const itemCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
const rec = z.record(itemCode, z.number().int().min(1));
console.log('rec', rec.safeParse({desk:12, Chair:1}).success, rec.safeParse({desk:12}).success);
