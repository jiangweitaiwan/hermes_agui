export interface Usage { promptTokens:number|null; completionTokens:number|null }
export function tokenCount(value:unknown):number|null{return Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;}
export function usage(prompt:unknown,completion:unknown):Usage{return {promptTokens:tokenCount(prompt),completionTokens:tokenCount(completion)};}
