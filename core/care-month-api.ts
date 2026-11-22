import { z } from 'zod'
import { MonthEntrySchema, TargetMonth, type MonthEntry } from './care-month.ts'
export const MonthPreviewInput = z.object({planId:z.uuid(),month:TargetMonth}).strict()
export const MonthCreateInput = MonthPreviewInput.extend({requestId:z.uuid(),confirmationId:z.uuid(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export const MonthSaveInput = z.object({requestId:z.uuid(),baseVersion:z.number().int().positive(),entries:z.array(MonthEntrySchema).max(5000)}).strict()
export const MonthActionInput = z.discriminatedUnion('action',[
 z.object({action:z.literal('regenerate'),baseVersion:z.number().int().positive()}).strict(),
 z.object({action:z.literal('copy'),baseVersion:z.number().int().positive(),sourceMonthId:z.uuid()}).strict(),
])
export interface CareMonthView { id:string; clientId:string; planId:string; planVersion:number; confirmationId:string; sourceHash:string; month:string; documentId:string; lockVersion:number; revision:number; services:{id:string;content:string;provider:string|null;serviceKind:string|null;insured:boolean}[]; entries:MonthEntry[]; unexpanded:{serviceId:string;slotId:string;note:string|null}[] }
export interface CareMonthSaved { month:CareMonthView; revision:number; savedAt:string }

export type CareMonthSummary = Pick<CareMonthView, 'id'|'month'|'planId'|'planVersion'|'revision'>
