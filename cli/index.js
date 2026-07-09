module.exports = {
  'agent-chrome:status': {
    description: 'Show Agent Chrome service status URL.',
    run() {
      const port = process.env.ACS_BROKER_PORT || '9300';
      return `Agent Chrome broker: http://127.0.0.1:${port}/`;
    },
  },
};

