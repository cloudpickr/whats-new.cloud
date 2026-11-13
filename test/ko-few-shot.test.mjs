import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assessTranslationQuality, FEW_SHOT_KO } from '../worker/index.js';

// The Korean few-shots are the examples the translation model copies.
// They have to obey the same rules the prompt states and the same gate
// production applies: facts from the source only, no reader instructions,
// and a second sentence only when it adds a different fact.

const INSTRUCTION = /해야 합니다|하세요|하십시오|바랍니다|해 보세요|해보세요/;
const INVENTED = /콜드스타트|Composer 3|복원 지점|보존 기간|업그레이드를 검토/;

function sourceRow(userContent) {
  const title = userContent.match(/^Title: (.*)$/m)?.[1] ?? '';
  const description = userContent.match(/^Description: (.*)$/m)?.[1] ?? '';
  return { title_en: title, description_en: description };
}

describe('Korean few-shots match the translation rules', () => {
  const pairs = [];
  for (let i = 0; i < FEW_SHOT_KO.length; i += 2) {
    pairs.push({ user: FEW_SHOT_KO[i], assistant: FEW_SHOT_KO[i + 1] });
  }

  test('each example passes the production quality gate', () => {
    assert.equal(pairs.length, 3);
    for (const { user, assistant } of pairs) {
      const card = JSON.parse(assistant.content);
      const quality = assessTranslationQuality(card, sourceRow(user.content), 'ko');
      assert.deepEqual(quality.reasons, [], assistant.content);
      assert.equal(quality.pass, true);
    }
  });

  test('examples do not teach instructions or facts absent from the source', () => {
    for (const { assistant } of pairs) {
      const card = JSON.parse(assistant.content);
      const text = `${card.title} ${card.summary} ${card.features}`;
      assert.equal(INSTRUCTION.test(text), false, text);
      assert.equal(INVENTED.test(text), false, text);
      assert.equal(card.summary.split(/(?<=[.!?。])\s+/).length <= 2, true);
    }
  });

  test('a worldwide region claim appears only when the source states that scope', () => {
    const worldwide = /모든(?:\s+AWS|\s+Azure)?(?:\s+퍼블릭)?\s+리전|all regions/i;
    const sourceSaysAll = /all (?:aws |public azure |azure )?regions/i;
    for (const { user, assistant } of pairs) {
      const card = JSON.parse(assistant.content);
      const claimed = `${card.regions} ${card.summary} ${card.title}`;
      if (!worldwide.test(claimed)) continue;
      assert.match(user.content, sourceSaysAll, claimed);
    }
  });

  test('Composer names only the source region and states the creation limit once', () => {
    const composer = pairs.find((pair) => pair.user.content.includes('Cloud Composer'));
    const card = JSON.parse(composer.assistant.content);
    const items = card.features.split(',').map((item) => item.trim()).filter(Boolean);
    assert.equal(card.regions, 'australia-southeast2');
    assert.equal(items.filter((item) => /생성/.test(item)).length, 1);
    assert.equal(new Set(items).size, items.length);
  });

  test('Cosmos does not name a region the source never gives', () => {
    const cosmos = pairs.find((pair) => pair.user.content.includes('Cosmos'));
    const card = JSON.parse(cosmos.assistant.content);
    assert.equal(card.regions, '');
    assert.equal(/리전|region/i.test(`${card.summary} ${card.features}`), false);
  });
});
