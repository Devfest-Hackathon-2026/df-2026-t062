import { z } from 'zod'
import { FeeInputSchema,type FeeInput,type FeeResult } from './care-fees.ts'
export const FeeCalculateInput=FeeInputSchema.extend({requestId:z.uuid(),sourceRevision:z.number().int().positive(),baseRevision:z.number().int().min(0)}).strict()
export interface CareFeeCalculation { id:string;groupId:string;clientId:string;monthId:string;month:string;planId:string;planVersion:number;documentId:string;revision:number;sourceRevision:number;sourceRevisionId:string;sourceHash:string;masterId:string;masterHash:string;createdAt:string;createdBy:string;input:FeeInput;result:FeeResult }
export interface CareFeeSummary {id:string;monthId:string;month:string;basis:'planned'|'actual';revision:number;status:'calculated'|'needs_review'}
