import type { SourceCoverage } from '../features/directory/directory-store'
import type { Teammate } from '../features/roster/roster'

export interface ProfileServiceability {
  teammateId: string
  profile: string
  servedByGateway: boolean
}

export interface ProfileSelectorOption {
  teammateId: string
  profile: string
  name: string
  servedByGateway: boolean
  selectable: boolean
  optionLabel: string
  statusLabel: string | null
  detail: string | null
}

const unavailableDetail = 'Ten profil nie jest obsługiwany przez bieżący gateway. Zmień konfigurację gatewaya, aby używać go w aplikacji.'
const hardError = (coverage: SourceCoverage | undefined) => Boolean(coverage
  && [coverage.status, coverage.sessionStatus, coverage.projectStatus].some((status) => status === 'error' || status === 'offline' || status === 'unsupported'))

export function buildProfileSelectorModel(
  teammates: readonly Teammate[],
  serviceability: readonly ProfileServiceability[],
  coverage: readonly SourceCoverage[]
): readonly ProfileSelectorOption[] {
  const serviceabilityById = new Map(serviceability.map((item) => [item.teammateId, item]))
  const coverageByProfile = new Map(coverage.map((item) => [item.profile, item]))

  return teammates.map((teammate) => {
    const service = serviceabilityById.get(teammate.id)
    const profile = service?.profile ?? teammate.id
    const served = service?.servedByGateway !== false
    const selectable = served && !hardError(coverageByProfile.get(profile))

    return {
      teammateId: teammate.id,
      profile,
      name: teammate.name,
      servedByGateway: served,
      selectable,
      optionLabel: selectable ? teammate.name : `${teammate.name} — niedostępny`,
      statusLabel: selectable ? null : 'Niedostępny w tym połączeniu',
      detail: served ? null : unavailableDetail
    }
  })
}
