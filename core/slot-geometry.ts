/** mm・左上原点。意味の対応は変えず、用紙内の位置だけを直す。 */
export interface SlotGeometry { x:number; y:number; w:number; h:number }
export function geometryProblem(box:SlotGeometry,page:{width:number;height:number}):string|null {
 if(!Object.values(box).every(Number.isFinite))return '位置と大きさを数値で入力してください。'
 if(box.w<=0||box.h<=0)return '幅と高さは0より大きくしてください。'
 if(box.x<0||box.y<0||box.x+box.w>page.width+.01||box.y+box.h>page.height+.01)return '欄が用紙の外に出ています。位置と大きさを確認してください。'
 return null
}
