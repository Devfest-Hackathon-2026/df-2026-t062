interface Attendee { id: string; affiliation: string; profession: string; name: string }
export function MeetingFields({ values, setValue }: { values: Record<string, unknown>; setValue: (key: string, value: unknown) => void }) {
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : ''
  const attendees = Array.isArray(values['meeting.attendees']) ? values['meeting.attendees'] as Attendee[] : []
  const update = (id: string, field: keyof Attendee, value: string) => setValue('meeting.attendees', attendees.map(a => a.id === id ? { ...a, [field]: value } : a))
  return <>
    <div className="care-record-dates">{[['開催日', 'meeting.date', 'date'], ['作成年月日', 'plan.createdDate', 'date'], ['開始時刻', 'meeting.start', 'time'], ['終了時刻', 'meeting.end', 'time']].map(([label, key, type]) => <label key={key}>{label}<input type={type} value={text(key)} onChange={e => setValue(key, e.target.value || null)} /></label>)}</div>
    <label>開催場所<input value={text('meeting.place')} onChange={e => setValue('meeting.place', e.target.value || null)} /></label>
    <label>開催回数<input type="number" min={1} step={1} value={typeof values['meeting.number'] === 'number' ? values['meeting.number'] : ''} onChange={e => setValue('meeting.number', e.target.value === '' ? null : Number(e.target.value))} /></label>
    <div className="care-record-dates">{[['本人の出席', 'meeting.personAttended'], ['家族の出席', 'meeting.familyAttended']].map(([label, key]) => <label key={key}>{label}<select aria-label={label} value={text(key)} onChange={e => setValue(key, e.target.value || null)}><option value="">未入力</option>{['出席', '欠席', '不明'].map(v => <option key={v}>{v}</option>)}</select></label>)}<label>家族の続柄<input value={text('meeting.relationship')} onChange={e => setValue('meeting.relationship', e.target.value || null)} /></label></div>
    <fieldset><legend>会議出席者</legend>{attendees.map((a, i) => <div key={a.id} className="care-record-attendee"><div className="care-record-dates">{[['所属', 'affiliation'], ['職種', 'profession'], ['氏名', 'name']].map(([label, field]) => <label key={field}>{label}<input aria-label={`出席者${i + 1}の${label}`} value={a[field as keyof Attendee] ?? ''} onChange={e => update(a.id, field as keyof Attendee, e.target.value)} /></label>)}</div><button type="button" className="btn" aria-label={`出席者${i + 1}を削除`} onClick={() => setValue('meeting.attendees', attendees.filter(row => row.id !== a.id))}>出席者を削除</button></div>)}<button type="button" className="btn" onClick={() => setValue('meeting.attendees', [...attendees, { id: crypto.randomUUID(), affiliation: '', profession: '', name: '' }])}>出席者を追加</button></fieldset>
    {[
      ['検討した項目', 'meeting.items'], ['検討内容', 'meeting.discussion'], ['結論', 'meeting.conclusion'], ['残された課題', 'meeting.remaining'], ['次回の開催時期', 'meeting.nextDate'],
    ].map(([label, key]) => <label key={key}>{label}<textarea aria-label={label} value={text(key)} onChange={e => setValue(key, e.target.value || null)} rows={key === 'meeting.discussion' ? 8 : 3} maxLength={100000} /></label>)}
    <label>記載者<input value={text('office.careManagerName')} onChange={e => setValue('office.careManagerName', e.target.value || null)} /></label>
  </>
}
