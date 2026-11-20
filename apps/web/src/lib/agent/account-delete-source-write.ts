import type { PrismaClient } from '@prisma/client'
import { acquireSourceMaterialFence } from './source-material-fence'

export type AccountDeleteClient = Pick<PrismaClient, '$transaction'>
export type AccountDeleteResult = 'deleted' | 'not_found' | 'confirmation_required'

/** Deletes the authenticated user's account under the tenant source-material fence. */
export async function deleteAccountWithSourceFence(
  client: AccountDeleteClient,
  userId: string,
  confirmation: string,
): Promise<AccountDeleteResult> {
  return client.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [userId])

    const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } })
    if (!user) return 'not_found'
    if (!confirmation.trim() || confirmation.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      return 'confirmation_required'
    }

    await tx.user.delete({ where: { id: userId } })
    return 'deleted'
  })
}
