const state = require('./state');

const context = {
  state,
  set(key, value) {
    context[key] = value;
    return context[key];
  },
  get(key) {
    return context[key];
  }
};

module.exports = context;
