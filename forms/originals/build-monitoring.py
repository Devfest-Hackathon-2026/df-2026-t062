"""アプリ独自のモニタリング原紙。公式様式の転載ではない。ReportLab で再生成する。"""
from pathlib import Path
import json,hashlib
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm
root=Path(__file__).resolve().parents[2]
pdfmetrics.registerFont(TTFont('BIZ',str(root/'forms/fonts/BIZUDPGothic-Regular.ttf')))
font='BIZ'
areas=[('monitoring.personOpinion','ご本人の意向・満足度'),('monitoring.familyOpinion','ご家族の意向・支援状況'),('monitoring.goalStatus','目標の達成状況・生活上の課題'),('monitoring.serviceContacts','サービスの実施状況・事業所との連絡'),('monitoring.changes','心身・生活状況の変化'),('monitoring.medicalReport','医療者への報告・連携の内容'),('monitoring.nextActions','今後の対応・次回の確認事項')]
file=root/'forms/originals/monitoring.pdf'
c=Canvas(str(file),pagesize=(210*mm,297*mm),invariant=1,pageCompression=1)
c.setTitle('モニタリング記録（アプリ標準様式）');c.setAuthor('df-2026-t062-dev contributors')
def label(text,x,y,size=9):c.setFont(font,size);c.drawString(x*mm,(297-y)*mm,text)
def box(x,y,w,h):c.setLineWidth(.25*mm);c.rect(x*mm,(297-y-h)*mm,w*mm,h*mm)
label('モニタリング記録',72,19,17);label('アプリ標準様式',163,19,7)
label('利用者名',12,32);box(32,25,83,11)
label('実施日',120,32);box(137,25,61,11)
label('担当者',12,45);box(32,38,83,11)
label('確認方法',120,45);box(142,38,56,11)
schemas=[];bindings={}
def slot(key,name,x,y,w,h,area=False):
 s=dict(name=name,type='text',content='',position=dict(x=x,y=y),width=w,height=h,fontName='BIZUDPGothic',fontSize=9,fontColor='#1a3fa0',alignment='left',verticalAlignment='top' if area else 'middle',lineHeight=1.15,characterSpacing=0,dynamicFontSize=dict(min=5,max=9,fit='vertical' if area else 'horizontal'))
 schemas.append(s);bindings[name]=dict(op='text@1',ui='area' if area else 'text',ref=dict(key=key))
slot('person.name','利用者名',33,26,81,9);slot('monitoring.date','実施日',138,26,59,9)
slot('office.careManagerName','担当者',33,39,81,9);slot('monitoring.method','確認方法',143,39,54,9)
for i,(key,title) in enumerate(areas):
 y=54+i*32;label(title,13,y+4,9);box(12,y+6,186,24);slot(key,title,13,y+7,184,22,True)
label('モニタリング記録 / アプリ独自の簡易様式（公式指定様式ではありません）',12,291,7)
c.save()
sha=hashlib.sha256(file.read_bytes()).hexdigest()
meta=dict(kind='monitoring',name='モニタリング記録',title='モニタリング記録（アプリ標準様式）',publisher='アプリ標準（独自様式）',sourceUrl=None,sourceFile='monitoring.pdf',basePdfSha256=sha,pages=[dict(no=1,pdfIndex=0,title='モニタリング記録',width=210,height=297)])
for name,data in [('form',meta),('template',dict(schemas=[schemas])),('bindings',bindings)]:
 (root/f'forms/seed/monitoring/{name}.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
print(sha)
