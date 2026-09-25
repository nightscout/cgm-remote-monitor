'use strict';

const assert = require('assert');
const german = require('../docs/plugins/alexa-templates/de-de.json').interactionModel;
const english = require('../docs/plugins/alexa-templates/en-us.json').interactionModel;

describe('German Alexa interaction model', function () {
  it('preserves the backend intent names and canonical metric values', function () {
    assert.deepStrictEqual(german.languageModel.intents.map(i => i.name).sort(),
      english.languageModel.intents.map(i => i.name).sort());
    function metrics (model) {
      return model.languageModel.types.find(t => t.name === 'LIST_OF_METRICS')
        .values.map(v => v.name.value).sort();
    }
    assert.deepStrictEqual(metrics(german), metrics(english));
  });

  it('resolves utterance slots and dialog prompts against declared names', function () {
    german.languageModel.intents.forEach(function (intent) {
      const slots = intent.slots || [];
      const names = slots.map(s => s.name);
      [intent].concat(slots).forEach(function (item) {
        (item.samples || []).forEach(function (sample) {
          for (const match of sample.matchAll(/\{([^}]+)\}/g)) {
            assert(names.includes(match[1]), sample);
          }
        });
      });
    });
    const prompts = german.prompts.map(p => p.id);
    german.dialog.intents.forEach(function (dialog) {
      const intent = german.languageModel.intents.find(i => i.name === dialog.name);
      assert(intent);
      dialog.slots.forEach(function (slot) {
        assert(intent.slots.some(s => s.name === slot.name && s.type === slot.type));
        Object.values(slot.prompts).forEach(id => assert(prompts.includes(id)));
      });
    });
    const metric = german.languageModel.intents.find(i => i.name === 'MetricNow');
    assert.strictEqual(metric.slots.find(s => s.name === 'pwd').type, 'AMAZON.FirstName');
  });
});
