import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assessTranslationQuality, qualityRefreshAction } from '../worker/index.js';

describe('quality refresh threshold', () => {
  test('a passing card and a long title are kept', () => {
    assert.equal(qualityRefreshAction([]), 'skip');
    assert.equal(qualityRefreshAction(['title-too-long']), 'skip');
    assert.equal(qualityRefreshAction(['title-too-long', 'title-too-long']), 'skip');
  });

  test('any hard reason refreshes, even beside a long title', () => {
    assert.equal(qualityRefreshAction(['summary-imperative']), 'refresh');
    assert.equal(qualityRefreshAction(['title-too-long', 'summary-sentence-count']), 'refresh');
    assert.equal(qualityRefreshAction(['title-hallucinated']), 'refresh');
  });

  test('the production gate feeds the same decision', () => {
    const source = {
      title_en: 'AWS Lambda now supports Python 3.13 runtime',
      description_en: 'Customers can create Lambda functions using Python 3.13.',
    };
    const longTitle = assessTranslationQuality({
      title: 'Amazon Managed Service for Prometheus에서 Amazon MSK 컨슈머 그룹 메트릭을 추가로 지원',
      summary: 'Amazon Managed Service for Prometheus에서 Amazon MSK 컨슈머 그룹 메트릭을 수집할 수 있게 되었습니다.',
      target: 'Prometheus로 메트릭을 보는 운영자',
      features: 'MSK 메트릭 수집, 컨슈머 그룹 지원',
      regions: '모든 AWS 리전',
      status: ['정식 출시'],
    }, source, 'ko');
    assert.equal(longTitle.reasons.includes('title-too-long'), true);
    assert.equal(qualityRefreshAction(longTitle.reasons), 'skip');

    const imperative = assessTranslationQuality({
      title: 'AWS Lambda Python 3.13 런타임 지원',
      summary: 'AWS Lambda에서 Python 3.13 런타임을 선택할 수 있게 되었습니다. 변경 내용을 문서에서 참조하세요.',
      target: 'Lambda를 운영하는 백엔드 개발자',
      features: 'Python 3.13 런타임, 오류 메시지 개선',
      regions: '모든 AWS 리전',
      status: ['정식 출시'],
    }, source, 'ko');
    assert.equal(imperative.reasons.includes('summary-imperative'), true);
    assert.equal(qualityRefreshAction(imperative.reasons), 'refresh');
  });
});
