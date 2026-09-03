import { db } from '../lib/db';
import { connectionState } from '../lib/whatsapp/evolution';

export async function syncWaStatus(workspaceId: string) {
  const list = await db.waInstance.findMany({ where: { workspaceId } });
  for (const wa of list) {
    try {
      const s = await connectionState(wa.instanceName);
      const state = s.instance?.state ?? 'close';
      await db.waInstance.update({
        where: { id: wa.id },
        data: { status: state === 'open' ? 'connected' : state === 'connecting' ? 'qr' : 'disconnected', lastError: null },
      });
    } catch (e) {
      await db.waInstance.update({
        where: { id: wa.id },
        data: { status: 'error', lastError: e instanceof Error ? e.message : String(e) },
      });
    }
  }
}
