import type { AllocateInput, Group, Item, ItemCode, Room, Consent } from './types.ts';
import { distribute, mulberry32, partition, shuffle, uuid, type Rng } from './rng.ts';

// 05_development.md「R8 の実績」の在庫（使用不可の部屋の分を含む）
export const R8_STOCK: Record<ItemCode, number> = {
  desk: 506, desk_ng: 41, chair: 493, chair_ng: 40, caster_desk: 180,
  chair_blue: 432, long_desk_3: 8, long_desk_2: 127, lectern: 27,
};
// 使用不可（第一セミナー）の分
export const UNUSABLE_STOCK: Partial<Record<ItemCode, number>> = {
  caster_desk: 1, chair_blue: 49, long_desk_2: 25, lectern: 2,
};
const ITEM_CODES: ItemCode[] = ['desk', 'desk_ng', 'chair', 'chair_ng', 'caster_desk', 'chair_blue', 'long_desk_3', 'long_desk_2', 'lectern'];

export type Dummy = {
  input: AllocateInput;
  /** 名前で引く（テスト・ベンチ用） */
  roomByName: Map<string, Room>;
  groupByName: Map<string, Group>;
  itemByCode: Map<ItemCode, Item>;
};

export function generate(seed = 20261029): Dummy {
  const r = mulberry32(seed);
  const items: Item[] = ITEM_CODES.map((code, k) => ({ id: uuid(r), code, sortOrder: k + 1 }));
  const itemByCode = new Map(items.map((i) => [i.code, i]));

  // ---- 保管場所 40 + 屋外の使用場所 16 ----
  const rooms: Room[] = [];
  const addRoom = (name: string, kind: Room['kind'], building: string | null, floor: number | null, extraCost = 0, usable = true) =>
    rooms.push({ id: uuid(r), name, kind, building, floor, extraCost, usable, sortOrder: rooms.length + 1 });
  for (const n of ['1-1', '1-2', '1-3']) addRoom(n, 'room', '教室棟A', 1);
  for (const n of ['2-1', '2-2', '2-3']) addRoom(n, 'room', '教室棟A', 2);
  for (const n of ['3-1', '3-2', '3-3']) addRoom(n, 'room', '教室棟B', 1);
  for (const n of ['4-1', '4-2', '4-3']) addRoom(n, 'room', '教室棟B', 2);
  for (const n of ['5-1', '5-2', '5-3']) addRoom(n, 'room', '教室棟C', 1);
  for (const [n, f] of [['専1', 1], ['専2', 1], ['専3', 2]] as const) addRoom(n, 'room', '専攻科棟', f);
  for (const [n, f, x] of [['CI1', 1, 0], ['CI2', 1, 0], ['CI3', 2, 0], ['CI4', 2, 0], ['CI5', 2, 2]] as const) addRoom(n, 'room', '実験棟', f, x);
  for (const [n, f] of [['HI1', 1], ['HI2', 1], ['HI3', 2], ['HI4', 2]] as const) addRoom(n, 'room', '情報棟', f);
  addRoom('MER', 'room', '情報棟', 1);
  addRoom('第一セミナー', 'room', '管理棟', 1, 0, false);
  addRoom('第二セミナー', 'room', '管理棟', 2);
  addRoom('第一多目的室', 'room', '管理棟', 1);
  addRoom('第二多目的室', 'room', '管理棟', 2);
  addRoom('体育館', 'gym', '体育館', 1);
  addRoom('倉庫1', 'other', '倉庫', 1);
  addRoom('倉庫2', 'other', '倉庫', 1);
  addRoom('倉庫3', 'other', '倉庫', 1);
  addRoom('武道場', 'gym', '武道場', 1);
  addRoom('図書館1階', 'room', '図書館', 1);
  addRoom('図書館2階', 'room', '図書館', 2);
  addRoom('食堂', 'room', '食堂', 1);
  const storageCount = rooms.length;
  for (let k = 1; k <= 16; k++) addRoom(`外${k}`, 'outdoor', null, null);
  const roomByName = new Map(rooms.map((x) => [x.name, x]));
  const R = (n: string) => roomByName.get(n)!;
  const s05Rooms = ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'];

  // ---- 在庫 ----
  const stocks: AllocateInput['stocks'] = [];
  const usable = rooms.slice(0, storageCount).filter((x) => x.usable);
  const fixedAmount: Record<string, Partial<Record<ItemCode, number>>> = {
    '第一多目的室': { desk: 20, chair: 30 },
    'MER': { desk: 20, chair: 25, caster_desk: 15, chair_blue: 20, long_desk_2: 3 },
  };
  for (const code of ITEM_CODES) {
    const total = R8_STOCK[code] - (UNUSABLE_STOCK[code] ?? 0);
    const fixed = usable.filter((x) => fixedAmount[x.name]?.[code] != null);
    const fixedSum = fixed.reduce((a, x) => a + fixedAmount[x.name]![code]!, 0);
    for (const x of fixed) stocks.push({ roomId: x.id, itemId: itemByCode.get(code)!.id, count: fixedAmount[x.name]![code]! });
    const rest = usable.filter((x) => !fixed.includes(x));
    // 机(木)は S05 の 6 部屋に 280 台
    if (code === 'desk') {
      const s05 = rest.filter((x) => s05Rooms.includes(x.name));
      const other = rest.filter((x) => !s05Rooms.includes(x.name));
      const a = distribute(280, s05.map(() => 0.5 + r()));
      s05.forEach((x, k) => stocks.push({ roomId: x.id, itemId: itemByCode.get(code)!.id, count: a[k]! }));
      const b = distribute(total - fixedSum - 280, other.map(() => (r() < 0.35 ? 0 : 0.2 + r())));
      other.forEach((x, k) => b[k]! > 0 && stocks.push({ roomId: x.id, itemId: itemByCode.get(code)!.id, count: b[k]! }));
      continue;
    }
    // 少数の部屋にだけ置く品目（不可机・不可椅子・長机3）
    const sparse = code === 'desk_ng' || code === 'chair_ng' || code === 'long_desk_3';
    const w: number[] = rest.map(() => (r() < (sparse ? 0.75 : 0.35) ? 0 : 0.2 + r() * r() * 2));
    if (Math.max(...w) === 0) w[0] = 1;
    const a = distribute(total - fixedSum, w);
    rest.forEach((x, k) => a[k]! > 0 && stocks.push({ roomId: x.id, itemId: itemByCode.get(code)!.id, count: a[k]! }));
  }
  for (const [code, n] of Object.entries(UNUSABLE_STOCK)) {
    stocks.push({ roomId: R('第一セミナー').id, itemId: itemByCode.get(code as ItemCode)!.id, count: n! });
  }

  // ---- 団体 55（模擬店39・部門11・企業3・休憩所2）----
  const groups: Group[] = [];
  const addGroup = (name: string, category: Group['category'], loc: string | null) =>
    groups.push({ id: uuid(r), name, category, locationRoomId: loc ? R(loc).id : null, sortOrder: groups.length + 1 });
  const indoorStallRooms = ['1-1', '1-2', '2-1', '2-3', '3-1', '3-2', '3-3', '4-1', '4-2', '4-3', '5-1', '5-2', '5-3',
    '専1', '専2', '専3', 'CI1', 'CI2', 'HI1', 'HI2', '第二セミナー', '第二多目的室', '図書館1階', '2-2', '1-3'];
  for (let k = 0; k < 25; k++) addGroup(`模擬店${String(k + 1).padStart(2, '0')}`, 'stall', indoorStallRooms[k]!);
  for (let k = 0; k < 14; k++) addGroup(`模擬店${String(k + 26).padStart(2, '0')}`, 'stall', `外${k + 1}`);
  addGroup('設営', 'department', '体育館');
  addGroup('学科展示', 'department', '第一多目的室');
  const deptRooms = ['CI3', 'CI4', 'CI5', 'HI3', 'HI4', 'MER', '倉庫1', '武道場', '図書館2階'];
  deptRooms.forEach((n, k) => addGroup(`部門${String(k + 1).padStart(2, '0')}`, 'department', n));
  addGroup('企業1', 'company', '武道場');
  addGroup('企業2', 'company', '食堂');
  addGroup('企業3', 'company', '外15');
  addGroup('休憩所1', 'rest_area', '図書館1階');
  addGroup('休憩所2', 'rest_area', '食堂');
  // 決定性の確認用：同名・同 sort_order で id だけが違う団体を1組作る
  groups[30]!.name = groups[29]!.name;
  groups[30]!.sortOrder = groups[29]!.sortOrder;
  const groupByName = new Map(groups.map((g) => [g.name, g]));
  const stalls = groups.filter((g) => g.category === 'stall');
  const indoorStalls = stalls.slice(0, 25);
  const outdoorStalls = stalls.slice(25);
  const depts = groups.filter((g) => g.category === 'department');
  const companies = groups.filter((g) => g.category === 'company');
  const rests = groups.filter((g) => g.category === 'rest_area');
  const setup = depts[0]!;
  const exhibit = depts[1]!;
  const otherDepts = depts.slice(1); // 学科展示を含む 10 部門

  // ---- 申請（合計は R8 の振り分け計の復元：N = 1,295）----
  const reqMap = new Map<string, number>();
  const req = (g: Group, code: ItemCode, n: number) => {
    if (n > 0) reqMap.set(`${g.id}|${itemByCode.get(code)!.id}`, (reqMap.get(`${g.id}|${itemByCode.get(code)!.id}`) ?? 0) + n);
  };
  const spread = (gs: Group[], code: ItemCode, total: number, min = 0) => partition(total, gs.length, min, r).forEach((n, k) => req(gs[k]!, code, n));
  const pick = (gs: Group[], n: number) => shuffle(gs, r).slice(0, n);
  // 机(木)系の需要 644 = 机506 + 不可机41 + キャスター97 を置き換え前の 机(木) で申請
  req(setup, 'desk', 241);
  spread(indoorStalls, 'desk', 217, 3);
  spread(outdoorStalls, 'desk', 70, 2);
  req(exhibit, 'desk', 18); // 残す 12 + 追加 6
  spread(otherDepts.slice(1), 'desk', 82, 6);
  spread(companies, 'desk', 12, 4);
  spread(rests, 'desk', 4, 2);
  // 椅子 372
  req(setup, 'chair', 20);
  spread(stalls, 'chair', 172, 1);
  req(exhibit, 'chair', 6); // 残す 4 + 追加 2
  spread(otherDepts.slice(1), 'chair', 94, 4);
  spread(companies, 'chair', 30, 5);
  spread(rests, 'chair', 50, 5);
  // 椅子(青) 134
  spread(pick(otherDepts, 6), 'chair_blue', 80, 5);
  spread(pick(stalls, 12), 'chair_blue', 54, 1);
  // キャスター机 29（直接の申請）、教卓 10
  spread(pick(otherDepts, 5), 'caster_desk', 29, 2);
  spread(pick(otherDepts, 5), 'lectern', 10, 1);
  // 長机(3人掛) 企業 10（在庫 8 を 2 超過 → S04）、長机(2人掛) 96
  req(companies[0]!, 'long_desk_3', 4); req(companies[1]!, 'long_desk_3', 4); req(companies[2]!, 'long_desk_3', 2);
  const ldStalls = pick(stalls.filter((g) => g !== stalls[5]), 19);
  spread(ldStalls, 'long_desk_2', 38, 1);
  req(stalls[5]!, 'long_desk_3', 2); // 企業以外の3人掛 → 前処理 S03 で 2人掛に読み替え（最終 40）
  req(setup, 'long_desk_2', 10);
  spread(pick(otherDepts, 5), 'long_desk_2', 26, 2);
  spread(companies, 'long_desk_2', 20, 3);

  // ---- ルール（R8 の初期値）----
  const rules: AllocateInput['rules'] = [
    { code: 'S01', kind: 'substitute', params: { from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0 } },
    { code: 'S02', kind: 'substitute', params: { from: 'chair', to: 'chair_ng', categories: ['rest_area', 'stall'], cost: 0, preferCategory: 'rest_area' } },
    { code: 'S04', kind: 'substitute', params: { from: 'long_desk_3', to: 'long_desk_2', categories: ['company'], cost: 1 } },
    { code: 'S07', kind: 'substitute', params: { from: 'desk', to: 'caster_desk', categories: ['stall'], indoorOnly: true, cost: 3, needsConsent: true } },
    { code: 'S05', kind: 'source_restrict', params: { group: setup.id, items: ['desk'], rooms: s05Rooms.map((n) => R(n).id) } },
    { code: 'S06', kind: 'fixed_request', params: { group: setup.id, item: 'desk', count: 241 } },
    { code: 'S08', kind: 'keep', params: { group: exhibit.id, room: R('第一多目的室').id, items: { desk: 12, chair: 4 } } },
  ];
  // ---- 了承：屋内の模擬店。1団体だけ拒否 ----
  const consents: Consent[] = indoorStalls.map((g, k) => ({
    groupId: g.id, fromItemId: itemByCode.get('desk')!.id, toItemId: itemByCode.get('caster_desk')!.id,
    status: k === 3 ? 'declined' : k < 8 ? 'accepted' : 'not_asked',
  }));

  const requests = [...reqMap].map(([k, count]) => {
    const [groupId, itemId] = k.split('|');
    return { groupId: groupId!, itemId: itemId!, count };
  });

  const input: AllocateInput = {
    items, rooms, stocks, groups, requests, rules, consents, fixedRows: [],
    distanceOverrides: [
      { buildingA: '教室棟A', buildingB: '体育館', cost: 3 },
      { buildingA: '教室棟A', buildingB: '教室棟B', cost: 2 },
    ],
  };
  return { input, roomByName, groupByName, itemByCode };
}

/** 解けない版 1：S05 の 6 部屋の机(木)を 235 台にする（残りは他の部屋へ移す。合計の在庫は同じ）。 */
export function makeInfeasibleS05(d: Dummy): AllocateInput {
  const s05 = ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'].map((n) => d.roomByName.get(n)!.id);
  const deskId = d.itemByCode.get('desk')!.id;
  const stocks = d.input.stocks.map((s) => ({ ...s }));
  let cut = 280 - 235;
  for (const s of stocks) if (s.itemId === deskId && s05.includes(s.roomId) && cut > 0) { const t = Math.min(cut, s.count); s.count -= t; cut -= t; }
  const other = stocks.find((s) => s.itemId === deskId && !s05.includes(s.roomId))!;
  other.count += 280 - 235;
  return { ...d.input, stocks };
}
/** 解けない版 2：教卓の在庫を需要より少なくする（品目の合計が足りない）。 */
export function makeInfeasibleLectern(d: Dummy): AllocateInput {
  const id = d.itemByCode.get('lectern')!.id;
  let left = 5; // 需要 10 に対し、使える教卓を 5 台だけにする
  const stocks = d.input.stocks.map((s) => {
    if (s.itemId !== id) return { ...s };
    const keep = Math.min(left, s.count);
    left -= keep;
    return { ...s, count: keep };
  });
  return { ...d.input, stocks };
}

/** 配列の並びだけを変える（中身は同じ）。 */
export function shuffleInput(input: AllocateInput, seed: number): AllocateInput {
  const r: Rng = mulberry32(seed);
  return {
    ...input,
    items: shuffle(input.items, r), rooms: shuffle(input.rooms, r), groups: shuffle(input.groups, r),
    stocks: shuffle(input.stocks, r), requests: shuffle(input.requests, r), rules: shuffle(input.rules, r),
    consents: shuffle(input.consents, r), distanceOverrides: shuffle(input.distanceOverrides, r), fixedRows: shuffle(input.fixedRows, r),
  };
}
