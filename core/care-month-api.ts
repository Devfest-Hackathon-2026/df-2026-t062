import { z } from 'zod'
import { MonthEntrySchema, TargetMonth, type MonthEntry } from './care-month.ts'
export const MonthPreviewInput = z.object({planId:z.uuid(),month:TargetMonth}).strict()
export const MonthCreateInput = MonthPreviewInput.extend({requestId:z.uuid(),confirmationId:z.uuid(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
const headerDate=z.string().refine(v=>v==='' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v))
export const MonthHeaders=z.object({insurerNumber:z.string().regex(/^\d{0,12}$/).default(''),insurerName:z.string().max(200).default(''),insuredNumber:z.string().regex(/^\d{0,12}$/).default(''),submittedDate:headerDate.default(''),certificationStatus:z.enum(['','認定済','申請中']).optional(),furigana:z.string().max(200).optional(),birthDate:headerDate.optional(),sex:z.enum(['','男','女']).optional(),careLevel:z.enum(['','要介護1','要介護2','要介護3','要介護4','要介護5']).optional(),changedCareLevel:z.enum(['','要介護1','要介護2','要介護3','要介護4','要介護5']).optional(),careLevelChangeDate:headerDate.optional(),limitUnits:z.string().regex(/^\d{0,8}$/).optional(),limitFrom:z.string().regex(/^(?:|\d{4}-(?:0[1-9]|1[0-2]))$/).optional(),limitTo:z.string().regex(/^(?:|\d{4}-(?:0[1-9]|1[0-2]))$/).optional(),previousShortStayDays:z.string().regex(/^(?:|[0-9]|[12][0-9]|3[01])$/).optional(),shortStayDays:z.string().regex(/^(?:|[0-9]|[12][0-9]|3[01])$/).optional()}).strict()
export type MonthHeaderValues=z.infer<typeof MonthHeaders>
export const MonthSaveInput = z.object({requestId:z.uuid(),baseVersion:z.number().int().positive(),entries:z.array(MonthEntrySchema).max(5000),headers:MonthHeaders.optional()}).strict()
export const MonthActionInput = z.discriminatedUnion('action',[
 z.object({action:z.literal('regenerate'),baseVersion:z.number().int().positive()}).strict(),
 z.object({action:z.literal('copy'),baseVersion:z.number().int().positive(),sourceMonthId:z.uuid()}).strict(),
])
export interface CareMonthView { headers?:MonthHeaderValues; id:string; clientId:string; planId:string; planVersion:number; confirmationId:string; sourceHash:string; month:string; documentId:string; lockVersion:number; revision:number; services:{id:string;content:string;provider:string|null;serviceKind:string|null;insured:boolean}[]; entries:MonthEntry[]; unexpanded:{serviceId:string;slotId:string;note:string|null}[] }
export interface CareMonthSaved { month:CareMonthView; revision:number; savedAt:string }

export type CareMonthSummary = Pick<CareMonthView, 'id'|'month'|'planId'|'planVersion'|'revision'>
