/**
 * fetchAllGroups com getPictures=false (opt-in).
 *
 * Em 23/09/2026 uma sincronização de 29 grupos coincidiu, no mesmo segundo, com
 * "rate-overlimit" do WhatsApp num chip novo. A lista de grupos é UMA consulta; o
 * peso vem das fotos de perfil, uma por grupo. Com getPictures=false as fotos não
 * são buscadas. Sem o parâmetro, o comportamento continua idêntico.
 *
 *   npx tsx src/api/integrations/channel/whatsapp/group-list.spec.ts
 */
import { buildGroupList } from './group-list';

let falhas = 0;
const pass = (n: string) => console.log(`🟢 [PASS] ${n}`);
const fail = (n: string, d: string) => {
  console.log(`🔴 [FAIL] ${n} — ${d}`);
  falhas++;
};

const grupos = Array.from({ length: 12 }, (_, i) => ({
  id: `1203630000000000${String(i).padStart(2, '0')}@g.us`,
  subject: `Grupo ${i}`,
  participants: [{ id: `${i}@lid` }],
  creation: 1700000000 + i,
}));
const logger = { error: () => {} };

async function main() {
  {
    const nome = 'getPictures=false não busca nenhuma foto de perfil';
    let fotos = 0;
    const r = await buildGroupList(
      grupos,
      { getParticipants: 'false', getPictures: 'false' },
      async (id) => {
        fotos++;
        return { wuid: id, profilePictureUrl: 'x' };
      },
      logger,
      0,
    );
    fotos === 0 && r.length === 12 ? pass(nome) : fail(nome, `${fotos} foto(s) buscada(s), ${r.length} grupo(s)`);
  }
  {
    const nome = 'Sem getPictures: busca uma foto por grupo, como antes';
    let fotos = 0;
    const r = await buildGroupList(
      grupos,
      { getParticipants: 'false' },
      async (id) => {
        fotos++;
        return { wuid: id, profilePictureUrl: `foto-${id}` };
      },
      logger,
      0,
    );
    fotos === 12 && r[0].pictureUrl === `foto-${grupos[0].id}`
      ? pass(nome)
      : fail(nome, `${fotos} foto(s), pictureUrl=${r[0]?.pictureUrl}`);
  }
  {
    const nome = 'Sem getPictures: no máximo 5 fotos em paralelo, como antes';
    let emVoo = 0;
    let pico = 0;
    await buildGroupList(
      grupos,
      { getParticipants: 'false' },
      async (id) => {
        emVoo++;
        pico = Math.max(pico, emVoo);
        await new Promise((r) => setTimeout(r, 5));
        emVoo--;
        return { wuid: id, profilePictureUrl: null };
      },
      logger,
      0,
    );
    pico <= 5 ? pass(nome) : fail(nome, `pico de ${pico} em paralelo`);
  }
  {
    const nome = 'Mesmo formato com e sem foto; participantes só com getParticipants=true';
    const com = await buildGroupList(
      grupos,
      { getParticipants: 'true' },
      async (id) => ({ wuid: id, profilePictureUrl: null }),
      logger,
      0,
    );
    const sem = await buildGroupList(
      grupos,
      { getParticipants: 'true', getPictures: 'false' },
      async (id) => ({ wuid: id, profilePictureUrl: null }),
      logger,
      0,
    );
    const semPart = await buildGroupList(
      grupos,
      { getParticipants: 'false', getPictures: 'false' },
      async (id) => ({ wuid: id, profilePictureUrl: null }),
      logger,
      0,
    );
    const chavesCom = Object.keys(com[0]).sort().join(',');
    const chavesSem = Object.keys(sem[0]).sort().join(',');
    const problemas = [
      chavesCom !== chavesSem && `chaves diferentes: [${chavesCom}] x [${chavesSem}]`,
      !Array.isArray(sem[0].participants) && 'getParticipants=true sem participantes',
      'participants' in semPart[0] && 'getParticipants=false trouxe participantes',
      sem[0].size !== 1 && `size=${sem[0].size}`,
    ].filter(Boolean);
    problemas.length === 0 ? pass(nome) : fail(nome, problemas.join('; '));
  }
  console.log(falhas === 0 ? '\n🟢 FETCH ALL GROUPS: 0 FALHAS.' : `\n🔴 ${falhas} FALHA(S).`);
  process.exit(falhas === 0 ? 0 : 1);
}
main();
