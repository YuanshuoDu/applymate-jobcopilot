import { ADMIN_PERMISSION_KEYS } from '@/lib/admin/permissions'
import { adminError, adminJson, requestId, requireAdminActor } from '@/lib/admin/route-utils'

export async function GET(request: Request) {
  const correlationId = requestId(request)
  try {
    await requireAdminActor('admin_members.read', request)
    return adminJson({
      permissions: ADMIN_PERMISSION_KEYS.map(key => ({
        key,
        domain: key.split('.')[0],
        label: key.split('.')[1].replaceAll('_', ' '),
      })),
    }, 200, correlationId)
  } catch (error) {
    return adminError(error, correlationId)
  }
}
