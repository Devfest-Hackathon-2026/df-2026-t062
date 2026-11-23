interface Attendee { id: string; affiliation: string; profession: string; name: string }
export function MeetingFields({ values, setValue }: { values: Record<string, unknown>; setValue: (key: string, value: unknown) => void }) {
  const text = (key: string) => typeof values[key] === 'string' ? values[key] as string : ''
  const attendees = Array.isArray(values['meeting.attendees']) ? values['meeting.attendees'] as Attendee[] : []
  return <>
    <div className="care-record-dates">{[['開催日', 'meeting.date', 'date'], ['作成年月日', 'plan.createdDate', 'date'], ['開始時刻', 'meeting.start', 'time'], ['終了時刻', 'meeting.end', 'time']].map(([label, key, type]) => <label key={key}>{label}<input type={type} value={text(key)} onChange={e => setValue(key, e.target.value || null)} /></label>)}</div>
    <label>開催回数<input type="number" min={1} step={1} value={typeof values['meeting.number'] === 'number' ? values['meeting.number'] : ''} onChange={e => setValue('meeting.number', e.target.value === '' ? null : Number(e.target.value))} /></label>
    <div className="care-record-dates">{[['本人の出席', 'meeting.personAttended'], ['家族の出席', 'meeting.familyAttended']].map(([label, key]) => <label key={key}>{label}<select aria-label={label} value={text(key)} onChange={e => setValue(key, e.target.value || null)}><option value="">未入力</option>{['出席', '欠席', '不明'].map(v => <option key={v}>{v}</option>)}</select></label>)}</div>
    <fieldset>
      <legend>会議出席者</legend>
      <p>所属・職種・氏名は用紙の出席者欄に入力できます。</p>
      {attendees.map((attendee, index) => <p key={attendee.id}>
        {index + 1}. {attendee.name || '氏名未入力'} <button type="button" className="btn" aria-label={`出席者${index + 1}を削除`} onClick={() => setValue('meeting.attendees', attendees.filter(row => row.id !== attendee.id))}>削除</button>
      </p>)}
      <button type="button" className="btn" onClick={() => setValue('meeting.attendees', [...attendees, { id: crypto.randomUUID(), affiliation: '', profession: '', name: '' }])}>出席者を追加</button>
    </fieldset>
  </>
}
