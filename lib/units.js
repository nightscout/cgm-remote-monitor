function mgdlToMMOL(mgdl) {
  return (Math.round((mgdl / 18) * 10) / 10).toFixed(1);
}

function configure() {
  return {
    mgdlToMMOL: mgdlToMMOL
  }
}

module.exports = configure;