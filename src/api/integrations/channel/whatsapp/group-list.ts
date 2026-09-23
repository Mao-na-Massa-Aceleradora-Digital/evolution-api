type PictureFetcher = (groupId: string) => Promise<{ wuid?: string; profilePictureUrl?: string | null } | undefined>;

export interface GroupListOptions {
  getParticipants?: string;
  /**
   * Opt-in: 'false' não busca a foto de perfil de cada grupo. A lista em si é uma
   * consulta só; as fotos são uma ida à rede por grupo, e em rajada levam a
   * "rate-overlimit" do WhatsApp. Ausente ou qualquer outro valor: busca, como antes.
   */
  getPictures?: string;
}

/** Quantas fotos de perfil buscar em paralelo. */
const CONCURRENCY = 5;

/**
 * Monta a resposta de fetchAllGroups a partir do resultado de
 * groupFetchAllParticipating(). Sem getPictures=false, o comportamento é o de
 * sempre: fotos em lotes de 5, até 8s cada, com pausa entre lotes.
 */
export async function buildGroupList(
  fetch: any[],
  options: GroupListOptions,
  fetchPicture: PictureFetcher,
  logger: { error: (msg: string) => void },
  pauseBetweenBatchesMs = 300,
): Promise<any[]> {
  const withPictures = options.getPictures !== 'false';
  const groups: any[] = [];

  const toResult = (group: any, pictureUrl: string | null | undefined) => {
    const result = {
      id: group.id,
      subject: group.subject,
      subjectOwner: group.subjectOwner,
      subjectTime: group.subjectTime,
      pictureUrl,
      size: group.participants?.length ?? 0,
      creation: group.creation,
      owner: group.owner,
      desc: group.desc,
      descId: group.descId,
      restrict: group.restrict,
      announce: group.announce,
      isCommunity: group.isCommunity,
      isCommunityAnnounce: group.isCommunityAnnounce,
      linkedParent: group.linkedParent,
    };

    if (options.getParticipants == 'true') {
      result['participants'] = group.participants ?? [];
    }

    return result;
  };

  if (!withPictures) {
    for (const group of fetch) {
      if (!group) continue;
      groups.push(toResult(group, null));
    }
    return groups;
  }

  for (let i = 0; i < fetch.length; i += CONCURRENCY) {
    const batch = fetch.slice(i, i + CONCURRENCY);

    const batchResults = await Promise.all(
      batch.map(async (group) => {
        if (!group) return null;

        try {
          const picture = await Promise.race([
            fetchPicture(group.id),
            new Promise<{ wuid: string; profilePictureUrl: null }>((resolve) =>
              setTimeout(() => resolve({ wuid: group.id, profilePictureUrl: null }), 8000),
            ),
          ]);

          return toResult(group, picture?.profilePictureUrl);
        } catch (groupError) {
          logger.error(`Error processing group ${group?.id}: ${groupError}`);
          return null;
        }
      }),
    );

    groups.push(...batchResults.filter((result) => result !== null));

    // Pausa curta entre lotes para nao disparar rate-overlimit em instancias com muitos grupos.
    if (i + CONCURRENCY < fetch.length) {
      await new Promise((resolve) => setTimeout(resolve, pauseBetweenBatchesMs));
    }
  }

  return groups;
}
