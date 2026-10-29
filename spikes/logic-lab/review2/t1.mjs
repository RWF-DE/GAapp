import { z } from 'zod';
const dt = z.iso.datetime({ offset: true });
for (const s of ['2026-10-29T02:11:00.123456+00:00','2026-10-29T02:11:00+00:00','2026-10-29 02:11:00.123456+00','2026-10-29T11:11:00+09:00','2026-10-29T02:11:00Z'])
  console.log(s, dt.safeParse(s).success);
const u = z.uuid();
for (const s of ['00000000-0000-4000-8000-0000000000a1','2ed6657d-e927-568b-95e1-2665a8aea6a2','00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111'])
  console.log(s, u.safeParse(s).success);
// keep record key order / regex key
const itemCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
const keep = z.strictObject({ items: z.record(itemCode, z.number().int().min(1)) });
console.log(JSON.stringify(keep.safeParse({items:{desk:12,'Bad':1}})));
// strictObject with default in discriminatedUnion
const sub = z.strictObject({ from: itemCode, to: itemCode, indoorOnly: z.boolean().default(false)}).refine(p=>p.from!==p.to,{path:['to']});
const rule = z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('substitute'), params: sub}), z.strictObject({kind:z.literal('keep'), params: keep})]);
console.log(JSON.stringify(rule.safeParse({kind:'substitute', params:{from:'desk',to:'caster_desk'}})));
// json schema for form? 
