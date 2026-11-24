const serviceClan = 'http://127.0.0.1:47391';

export async function serviceClanConnection(id, { token, signal, fetcher = fetch }) {
  const response = await fetcher(`${serviceClan}/api/services/${encodeURIComponent(id)}/connection`, {
    headers: { 'X-Service-Clan-Token': token }, signal, redirect: 'error',
  });
  if (!response.ok) throw new Error('Service Clan HTTP ' + response.status);
  return response.json();
}
