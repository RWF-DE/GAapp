// 合成データ（設計 3.6）。T00 の spikes/highs/src/gen.ts を移したもの。
// - 乱数の列を T00 と同じに保つ：T00 で uuid(r) を呼んでいた場所（品目9・場所56・団体55の id）では uuid(r) を呼んで
//   値を捨て（捨て読み）、id は名前から UUIDv5 で作る（toYearData）。
// - 足す団体（剣道部の2団体・部門(校内分散)・未提出の団体）は、T00 の申請をすべて作った後に r() を使わずに足し、
//   申請は既存の団体から移す（品目ごとの需要の合計は変わらない）。
// - 品目コードは T00 の chair_blue ではなく blue_chair。同名の団体を作る仕掛けは外した。
import { ITEM_CODES, type GroupCategory, type KnownItemCode, type RoomKind } from '../constants';
import {
  emptyCounts,
  type FixtureConsent,
  type FixtureData,
  type FixtureGroup,
  type FixtureRequest,
  type FixtureRoom,
  type FixtureRule,
  type FixtureStock,
} from './fixtures';
import { distribute, mulberry32, partition, shuffle, uuidFromRng, type Rng } from './rng';

export const SYNTHETIC_SEED = 20261029;
export const SYNTHETIC_LABEL = 'r8like';
export const S05_ROOMS = ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'] as const;

/** 05「R8 の実績」の在庫（使用不可の部屋の分を含む） */
export const R8_STOCK: Record<KnownItemCode, number> = {
  desk: 506,
  desk_ng: 41,
  chair: 493,
  chair_ng: 40,
  caster_desk: 180,
  blue_chair: 432,
  long_desk_3: 8,
  long_desk_2: 127,
  lectern: 27,
};
/** 使用不可（第一セミナー）の分 */
export const UNUSABLE_STOCK: Partial<Record<KnownItemCode, number>> = {
  caster_desk: 1,
  blue_chair: 49,
  long_desk_2: 25,
  lectern: 2,
};

/** 提出日時：2026-07-01T12:00:00+09:00 に sort_order 分を足した時刻（r() を使わない） */
function submittedAtFor(sortOrder: number): string {
  const total = 12 * 60 + sortOrder;
  const day = 1 + Math.floor(total / (24 * 60));
  const hh = Math.floor((total % (24 * 60)) / 60);
  const mm = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `2026-07-${p(day)}T${p(hh)}:${p(mm)}:00+09:00`;
}

export function generateSynthetic(seed: number = SYNTHETIC_SEED): FixtureData {
  const r: Rng = mulberry32(seed);
  const burn = () => void uuidFromRng(r);

  // ---- 品目（fixtures に持たない。T00 の id の分だけ捨て読み） ----
  for (let k = 0; k < ITEM_CODES.length; k++) burn();

  // ---- 保管場所 40 + 屋外の使用場所 16 ----
  const rooms: FixtureRoom[] = [];
  const addRoom = (name: string, kind: RoomKind, building: string | null, floor: number | null, extraCost = 0, usable = true) => {
    burn();
    rooms.push({ name, kind, building, floor, isStorage: true, extraCost, sortOrder: rooms.length + 1, usable, aliases: [] });
  };
  for (const n of ['1-1', '1-2', '1-3']) addRoom(n, 'room', '教室棟A', 1);
  for (const n of ['2-1', '2-2', '2-3']) addRoom(n, 'room', '教室棟A', 2);
  for (const n of ['3-1', '3-2', '3-3']) addRoom(n, 'room', '教室棟B', 1);
  for (const n of ['4-1', '4-2', '4-3']) addRoom(n, 'room', '教室棟B', 2);
  for (const n of ['5-1', '5-2', '5-3']) addRoom(n, 'room', '教室棟C', 1);
  for (const [n, f] of [['専1', 1], ['専2', 1], ['専3', 2]] as const) addRoom(n, 'room', '専攻科棟', f);
  for (const [n, f, x] of [['CI1', 1, 0], ['CI2', 1, 0], ['CI3', 2, 0], ['CI4', 2, 0], ['CI5', 2, 2]] as const)
    addRoom(n, 'room', '実験棟', f, x);
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
  for (const room of rooms.slice(storageCount)) room.isStorage = false;

  // ---- 在庫 ----
  const stock = new Map<string, ReturnType<typeof emptyCounts>>(
    rooms.slice(0, storageCount).map((x) => [x.name, emptyCounts()]),
  );
  const put = (room: string, code: KnownItemCode, n: number) => {
    stock.get(room)![code] += n;
  };
  const usable = rooms.slice(0, storageCount).filter((x) => x.usable);
  const fixedAmount: Record<string, Partial<Record<KnownItemCode, number>>> = {
    第一多目的室: { desk: 20, chair: 30 },
    MER: { desk: 20, chair: 25, caster_desk: 15, blue_chair: 20, long_desk_2: 3 },
  };
  for (const code of ITEM_CODES) {
    const total = R8_STOCK[code] - (UNUSABLE_STOCK[code] ?? 0);
    const fixed = usable.filter((x) => fixedAmount[x.name]?.[code] != null);
    const fixedSum = fixed.reduce((a, x) => a + fixedAmount[x.name]![code]!, 0);
    for (const x of fixed) put(x.name, code, fixedAmount[x.name]![code]!);
    const rest = usable.filter((x) => !fixed.includes(x));
    // 机(木)は S05 の 6 部屋に 280 台
    if (code === 'desk') {
      const s05 = rest.filter((x) => (S05_ROOMS as readonly string[]).includes(x.name));
      const other = rest.filter((x) => !(S05_ROOMS as readonly string[]).includes(x.name));
      const a = distribute(280, s05.map(() => 0.5 + r()));
      s05.forEach((x, k) => put(x.name, code, a[k]!));
      const b = distribute(total - fixedSum - 280, other.map(() => (r() < 0.35 ? 0 : 0.2 + r())));
      other.forEach((x, k) => put(x.name, code, b[k]!));
      continue;
    }
    // 少数の部屋にだけ置く品目（不可机・不可椅子・長机3）
    const sparse = code === 'desk_ng' || code === 'chair_ng' || code === 'long_desk_3';
    const w: number[] = rest.map(() => (r() < (sparse ? 0.75 : 0.35) ? 0 : 0.2 + r() * r() * 2));
    if (Math.max(...w) === 0) w[0] = 1;
    const a = distribute(total - fixedSum, w);
    rest.forEach((x, k) => put(x.name, code, a[k]!));
  }
  for (const [code, n] of Object.entries(UNUSABLE_STOCK)) put('第一セミナー', code as KnownItemCode, n!);

  // ---- 団体 55（模擬店39・部門11・企業3・休憩所2） ----
  const groups: FixtureGroup[] = [];
  const addGroup = (name: string, category: GroupCategory, location: string | null) => {
    groups.push({
      name,
      displayName: null,
      category,
      isFood: false,
      location,
      sortOrder: groups.length + 1,
      submittedAt: null,
      aliases: [],
    });
    return name;
  };
  const indoorStallRooms = ['1-1', '1-2', '2-1', '2-3', '3-1', '3-2', '3-3', '4-1', '4-2', '4-3', '5-1', '5-2', '5-3',
    '専1', '専2', '専3', 'CI1', 'CI2', 'HI1', 'HI2', '第二セミナー', '第二多目的室', '図書館1階', '2-2', '1-3'];
  const gen = (name: string, category: GroupCategory, loc: string | null) => {
    burn();
    return addGroup(name, category, loc);
  };
  for (let k = 0; k < 25; k++) gen(`模擬店${String(k + 1).padStart(2, '0')}`, 'stall', indoorStallRooms[k]!);
  for (let k = 0; k < 14; k++) gen(`模擬店${String(k + 26).padStart(2, '0')}`, 'stall', `外${k + 1}`);
  gen('設営', 'department', '体育館');
  gen('学科展示', 'department', '第一多目的室');
  const deptRooms = ['CI3', 'CI4', 'CI5', 'HI3', 'HI4', 'MER', '倉庫1', '武道場', '図書館2階'];
  deptRooms.forEach((n, k) => gen(`部門${String(k + 1).padStart(2, '0')}`, 'department', n));
  gen('企業1', 'company', '武道場');
  gen('企業2', 'company', '食堂');
  gen('企業3', 'company', '外15');
  gen('休憩所1', 'rest_area', '図書館1階');
  gen('休憩所2', 'rest_area', '食堂');
  const names = (c: GroupCategory) => groups.filter((g) => g.category === c).map((g) => g.name);
  const stalls = names('stall');
  const indoorStalls = stalls.slice(0, 25);
  const outdoorStalls = stalls.slice(25);
  const depts = names('department');
  const companies = names('company');
  const rests = names('rest_area');
  const setup = depts[0]!;
  const exhibit = depts[1]!;
  const otherDepts = depts.slice(1); // 学科展示を含む 10 部門

  // ---- 申請（合計は R8 の振り分け計の復元：N = 1,295） ----
  const req = new Map<string, ReturnType<typeof emptyCounts>>();
  const add = (g: string, code: KnownItemCode, n: number) => {
    if (n <= 0) return;
    if (!req.has(g)) req.set(g, emptyCounts());
    req.get(g)![code] += n;
  };
  const spread = (gs: string[], code: KnownItemCode, total: number, min = 0) =>
    partition(total, gs.length, min, r).forEach((n, k) => add(gs[k]!, code, n));
  const pick = (gs: string[], n: number) => shuffle(gs, r).slice(0, n);
  // 机(木)系の需要 644 = 机506 + 不可机41 + キャスター97 を、置き換え前の机(木)で申請
  add(setup, 'desk', 241);
  spread(indoorStalls, 'desk', 217, 3);
  spread(outdoorStalls, 'desk', 70, 2);
  add(exhibit, 'desk', 18); // 残す 12 + 追加 6
  spread(otherDepts.slice(1), 'desk', 82, 6);
  spread(companies, 'desk', 12, 4);
  spread(rests, 'desk', 4, 2);
  // 椅子 372
  add(setup, 'chair', 20);
  spread(stalls, 'chair', 172, 1);
  add(exhibit, 'chair', 6); // 残す 4 + 追加 2
  spread(otherDepts.slice(1), 'chair', 94, 4);
  spread(companies, 'chair', 30, 5);
  spread(rests, 'chair', 50, 5);
  // 椅子(青) 134
  spread(pick(otherDepts, 6), 'blue_chair', 80, 5);
  spread(pick(stalls, 12), 'blue_chair', 54, 1);
  // キャスター机 29（直接の申請）、教卓 10
  spread(pick(otherDepts, 5), 'caster_desk', 29, 2);
  spread(pick(otherDepts, 5), 'lectern', 10, 1);
  // 長机(3人掛) 企業 10（在庫 8 を 2 超過 → S04）、長机(2人掛) 96
  add(companies[0]!, 'long_desk_3', 4);
  add(companies[1]!, 'long_desk_3', 4);
  add(companies[2]!, 'long_desk_3', 2);
  const ldStalls = pick(stalls.filter((g) => g !== stalls[5]), 19);
  spread(ldStalls, 'long_desk_2', 38, 1);
  // 企業以外の長机(3人掛)。DB の申請に残っていてよく、前処理で長机(2人掛)に読み替える（S03・D-05。最終 40）
  add(stalls[5]!, 'long_desk_3', 2);
  add(setup, 'long_desk_2', 10);
  spread(pick(otherDepts, 5), 'long_desk_2', 26, 2);
  spread(companies, 'long_desk_2', 20, 3);

  // ---- 足す団体（r() を使わない。申請は移すだけ） ----
  const mv = (from: string, to: string, code: KnownItemCode, n: number) => {
    const have = req.get(from)?.[code] ?? 0;
    const t = Math.min(n, have);
    if (!t) return;
    req.get(from)![code] -= t;
    add(to, code, t);
  };
  const k1 = addGroup('剣道部(飲食)', 'stall', '外16');
  const k2 = addGroup('剣道部(非飲食)', 'stall', '外16');
  const dist = addGroup('部門(校内分散)', 'department', null);
  addGroup('未提出の団体', 'stall', '外16');
  groups.find((g) => g.name === k1)!.isFood = true;
  mv(outdoorStalls[12]!, k1, 'desk', 2);
  mv(outdoorStalls[12]!, k1, 'chair', 2);
  mv(outdoorStalls[13]!, k2, 'desk', 2);
  mv(outdoorStalls[13]!, k2, 'chair', 2);
  mv(depts[10]!, dist, 'chair', 2);
  mv(depts[10]!, dist, 'desk', 2);
  for (const g of groups) g.submittedAt = g.name === '未提出の団体' ? null : submittedAtFor(g.sortOrder);

  // ---- ルール（R8 の初期値） ----
  const rules: FixtureRule[] = [
    { code: 'S01', kind: 'substitute', enabled: true, memo: '不可机は模擬店の机(木)の代わりにだけ使う',
      params: { from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0 } },
    { code: 'S02', kind: 'substitute', enabled: true, memo: '不可椅子は休憩所・模擬店の椅子(木)の代わり。同じ距離なら休憩所',
      params: { from: 'chair', to: 'chair_ng', categories: ['rest_area', 'stall'], cost: 0, preferCategory: 'rest_area' } },
    { code: 'S04', kind: 'substitute', enabled: true, memo: '企業の長机(3人掛)が足りなければ長机(2人掛)',
      params: { from: 'long_desk_3', to: 'long_desk_2', categories: ['company'], cost: 1 } },
    { code: 'S05', kind: 'source_restrict', enabled: true, memo: '設営の机(木)は 1-1〜2-3 から',
      params: { group: setup, items: ['desk'], rooms: [...S05_ROOMS] } },
    { code: 'S06', kind: 'fixed_request', enabled: true, memo: '設営の机(木)は241台（未提出のとき）',
      params: { group: setup, item: 'desk', count: 241 } },
    { code: 'S07', kind: 'substitute', enabled: true, memo: '屋内の模擬店の机(木)をキャスター机に（了承が要る）',
      params: { from: 'desk', to: 'caster_desk', categories: ['stall'], indoorOnly: true, cost: 3, needsConsent: true } },
    { code: 'S08', kind: 'keep', enabled: true, memo: '学科展示は第一多目的室の机12・椅子4を残す',
      params: { group: exhibit, room: '第一多目的室', items: { desk: 12, chair: 4 } } },
  ];
  // ---- 了承：屋内の模擬店。1団体だけ拒否 ----
  const consents: FixtureConsent[] = indoorStalls.map((g, k) => ({
    group: g,
    from: 'desk',
    to: 'caster_desk',
    status: k === 3 ? 'declined' : k < 8 ? 'accepted' : 'not_asked',
    count: null,
  }));

  const stocks: FixtureStock[] = rooms.slice(0, storageCount).map((x) => ({ room: x.name, counts: stock.get(x.name)! }));
  const requests: FixtureRequest[] = groups
    .filter((g) => req.has(g.name) && ITEM_CODES.some((c) => req.get(g.name)![c] > 0))
    .map((g) => ({ group: g.name, counts: req.get(g.name)! }));
  return {
    meta: { schemaVersion: 1, yearLabel: SYNTHETIC_LABEL, kind: 'synthetic' },
    rooms,
    groups,
    stocks,
    requests,
    consents,
    distanceOverrides: [
      { buildingA: '体育館', buildingB: '教室棟A', cost: 3 },
      { buildingA: '教室棟A', buildingB: '教室棟B', cost: 2 },
    ],
    rules,
  };
}

/** 場所の在庫を変える（テスト用。元の fixtures は変えない） */
export function withStock(fx: FixtureData, room: string, code: KnownItemCode, count: number): FixtureData {
  return {
    ...fx,
    stocks: fx.stocks.map((s) => (s.room === room ? { ...s, counts: { ...s.counts, [code]: count } } : s)),
  };
}

/** 部屋の使用可否を変える（テスト用） */
export function withUsable(fx: FixtureData, room: string, usable: boolean): FixtureData {
  if (!fx.rooms.some((x) => x.name === room)) throw new Error(`場所「${room}」がありません`);
  return { ...fx, rooms: fx.rooms.map((x) => (x.name === room ? { ...x, usable } : x)) };
}

/**
 * 解けない版（T00 の makeInfeasibleS05 と同じ作り方）：S05 の 6 部屋の机(木)を合わせて 235 台にし、
 * 減らした分を S05 以外で机(木)のある最初の場所（sort_order の順）に足す。在庫の合計は変わらない。
 */
export function makeInfeasibleS05(fx: FixtureData, target = 235): FixtureData {
  const s05 = new Set<string>(S05_ROOMS);
  const total = fx.stocks.filter((s) => s05.has(s.room)).reduce((a, s) => a + s.counts.desk, 0);
  let cut = total - target;
  if (cut <= 0) throw new Error('S05 の部屋の机がすでに少なすぎます');
  const moved = cut;
  const order = new Map(fx.rooms.map((x) => [x.name, x.sortOrder]));
  const stocks = fx.stocks
    .map((s) => ({ ...s, counts: { ...s.counts } }))
    .sort((a, b) => order.get(a.room)! - order.get(b.room)!);
  for (const s of stocks) {
    if (!s05.has(s.room) || cut <= 0) continue;
    const t = Math.min(cut, s.counts.desk);
    s.counts.desk -= t;
    cut -= t;
  }
  const usable = new Set(fx.rooms.filter((x) => x.usable).map((x) => x.name));
  const other = stocks.find((s) => !s05.has(s.room) && usable.has(s.room) && s.counts.desk > 0);
  if (!other) throw new Error('S05 以外に机(木)のある場所がありません');
  other.counts.desk += moved;
  const byRoom = new Map(stocks.map((s) => [s.room, s]));
  return { ...fx, stocks: fx.stocks.map((s) => byRoom.get(s.room)!) };
}
