export function currentTime({date=new Date(),timeZone='Asia/Shanghai'}={}) {
  const instant=date instanceof Date?date:new Date(date);
  if(!Number.isFinite(instant.getTime()))throw new Error('无效服务端时间');
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant);
  const fields=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return {source:'server_clock',timezone:timeZone,utc_iso:instant.toISOString(),local_date:`${fields.year}-${fields.month}-${fields.day}`,local_time:`${fields.hour}:${fields.minute}:${fields.second}`,weekday:new Intl.DateTimeFormat('zh-CN',{timeZone,weekday:'long'}).format(instant)};
}
export function clockInstruction(time) {
  return `可信服务端时钟：${time.local_date} ${time.weekday} ${time.local_time}，时区 ${time.timezone}（北京时间）。UTC：${time.utc_iso}。现实中的今天、明天按这个时区解释；用户故事里的日期不改变现实日期。日期不是训练知识，不需联网。需要刷新此刻时间时可调用 current_time。`;
}
