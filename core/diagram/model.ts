import { anatomySchema } from './body.ts'
import { sourceSchema } from './evidence.ts'
import { z } from "zod";
const number = z.number().finite();
const id = z.string().min(1).max(100);
const text = z.string().max(300);
const position = { x: number.min(0).max(820), y: number.min(0).max(560) };
export const itemSchema = z
  .object({
    id,
    kind: z.enum([
      "wall",
      "door",
      "toilet",
      "bathtub",
      "disability",
      "loss",
      "room",
      "bed",
      "rail",
      "step",
      "wheelchair",
      "furniture",
      "note",
      "pain",
      "paralysis",
      "contracture",
      "pressure",
    ]),
    label: text,
    anatomy: anatomySchema.optional(),
    sources: z.array(sourceSchema).max(20).optional(),
    ...position,
    width: number.gt(0).max(Math.hypot(820, 560)),
    wallLine: z.literal(true).optional(),
    railLine: z.literal(true).optional(),
    height: number.min(20).max(560),
    rotation: number.min(-360).max(360),
    view: z.enum(["front", "back"]).optional(),
    range: z.enum(["point", "area"]).optional(),
    labelOffsetY: z.number().min(-300).max(300).optional(),
    stepHeightCm: z.number().min(0).max(1000).nullable().optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.wallLine && item.kind !== 'wall') {
      ctx.addIssue({ code: 'custom', path: ['wallLine'], message: '線は壁にだけ指定できます' });
    }
    if (item.railLine && item.kind !== 'rail') {
      ctx.addIssue({ code: 'custom', path: ['railLine'], message: '手すりの線は手すりにだけ指定できます' });
    }
    if (!item.wallLine && !item.railLine && (item.width < 20 || item.width > 820)) {
      ctx.addIssue({ code: 'custom', path: ['width'], message: '幅は20〜820の範囲で指定してください' });
    }
  });
export const personSchema = z
  .object({
    id,
    name: text,
    sex: z.enum(["male", "female", "unknown"]),
    household: z.enum(["同居", "別居", "不明"]),
    deceased: z.boolean().nullable(),
    sources: z.array(sourceSchema).max(20).optional(),
    age: z.number().int().min(0).max(130).nullable().optional(),
    isSubject: z.boolean().optional(),
    x: number.min(0).max(700),
    y: number.min(0).max(450),
  })
  .strict();
export const relationSchema = z
  .object({
    id,
    source: id,
    target: id,
    kind: z.enum(["婚姻", "離婚", "親子"]),
    sources: z.array(sourceSchema).max(20).optional(),
  })
  .strict();
export const schema = z
  .object({
    version: z.literal(1),
    title: text,
    house: z
      .object({
        items: z.array(itemSchema).max(500),
        background: z
          .string()
          .max(8000000)
          .refine(
            (s) =>
              !s ||
              /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s),
            "背景画像の形式が不正です",
          ),
      })
      .strict(),
    body: z.object({ items: z.array(itemSchema).max(500) }).strict(),
    family: z
      .object({
        people: z.array(personSchema).max(100),
        relations: z.array(relationSchema).max(300),
      })
      .strict(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const ids = [
      ...d.house.items,
      ...d.body.items,
      ...d.family.people,
      ...d.family.relations,
    ].map((x) => x.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "IDが重複しています" });
    if (d.family.people.filter((p) => p.isSubject).length > 1)
      ctx.addIssue({ code: "custom", message: "本人を指定できるのは1人です" });
    const people = new Set(d.family.people.map((x) => x.id));
    const pairs = new Set<string>();
    d.family.relations.forEach((r) => {
      if (
        !people.has(r.source) ||
        !people.has(r.target) ||
        r.source === r.target
      )
        ctx.addIssue({ code: "custom", message: "関係の接続先が不正です" });
      const key =
        r.kind === "親子"
          ? `${r.kind}:${r.source}:${r.target}`
          : `${r.kind}:${[r.source, r.target].sort().join(":")}`;
      if (pairs.has(key))
        ctx.addIssue({ code: "custom", message: "関係が重複しています" });
      pairs.add(key);
    });
    const visiting = new Set<string>(),
      done = new Set<string>();
    function visit(p: string): boolean {
      if (visiting.has(p)) return true;
      if (done.has(p)) return false;
      visiting.add(p);
      for (const r of d.family.relations.filter(
        (r) => r.kind === "親子" && r.source === p,
      )) {
        if (visit(r.target)) return true;
      }
      visiting.delete(p);
      done.add(p);
      return false;
    }
    if ([...people].some(visit))
      ctx.addIssue({ code: "custom", message: "親子関係が循環しています" });
    d.body.items.forEach((i) => {
      if (!i.view)
        ctx.addIssue({
          code: "custom",
          message: "人体記号の正面・背面が必要です",
        });
    });
  });
export type Doc = z.infer<typeof schema>;
export type Item = z.infer<typeof itemSchema>;
export const housePaletteKinds: readonly Item["kind"][] = [
  "room", "wall", "door", "rail", "step", "bed", "toilet", "bathtub", "wheelchair", "furniture",
];
export type Person = z.infer<typeof personSchema>;
export type Relation = z.infer<typeof relationSchema>;
export type Tab = "house" | "family" | "body";
export const uid = () => crypto.randomUUID();
export const blank = (): Doc => ({
  version: 1,
  title: "無題のアセスメント",
  house: { items: [], background: "" },
  body: { items: [] },
  family: { people: [], relations: [] },
});
export function parseDocument(input: unknown): Doc {
  return schema.parse(input);
}
export function removePerson(d: Doc, id: string): Doc {
  return {
    ...d,
    family: {
      people: d.family.people.filter((p) => p.id !== id),
      relations: d.family.relations.filter(
        (r) => r.source !== id && r.target !== id,
      ),
    },
  };
}
export const labels: Record<Item["kind"], string> = {
  wall: "壁",
  door: "出入口",
  toilet: "便器",
  bathtub: "浴槽",
  disability: "障害",
  loss: "欠損",
  room: "部屋",
  bed: "ベッド",
  rail: "手すり",
  step: "段差",
  wheelchair: "車いす",
  furniture: "家具",
  note: "注記",
  pain: "痛み",
  paralysis: "麻痺",
  contracture: "拘縮",
  pressure: "褥瘡",
};
export const colors: Record<Item["kind"], string> = {
  wall: "#25394a",
  door: "#d9e3e8",
  toilet: "#e8f0f7",
  bathtub: "#d5eae7",
  disability: "#ffffff",
  loss: "#ffffff",
  room: "#dceae6",
  bed: "#d4e6f4",
  rail: "#26796d",
  step: "#f4d6a4",
  wheelchair: "#d9d3f3",
  furniture: "#e7dccb",
  note: "#fff4c9",
  pain: "#ffdfd7",
  paralysis: "#dcd8f6",
  contracture: "#ffe8b6",
  pressure: "#f4cde0",
};
