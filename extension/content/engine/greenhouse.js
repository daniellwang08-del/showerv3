// Greenhouse (boards.greenhouse.io / job-boards embed) helpers.
(() => {
  const AF = window.__AF;
  if (!AF) return;

  function isGreenhouseHost() {
    try {
      return /(?:^|\.)greenhouse\.io$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  function hasApplicationRoot() {
    try {
      return !!document.querySelector(
        'form#application-form, form.application--form, .application--container, .application--form'
      );
    } catch {
      return false;
    }
  }

  function isApplicationFrame() {
    return isGreenhouseHost() && hasApplicationRoot();
  }

  function isEmbedParent() {
    try {
      if (window.top !== window) return false;
      return !!document.querySelector(
        'iframe[src*="greenhouse.io"][src*="embed/job_app"], iframe[src*="greenhouse.io/embed/job_app"]'
      );
    } catch {
      return false;
    }
  }

  function embedIframe() {
    try {
      if (window.top !== window) return null;
      return (
        document.querySelector('iframe[src*="greenhouse.io/embed/job_app"]') ||
        document.querySelector('iframe[src*="greenhouse.io"][src*="job_app"]')
      );
    } catch {
      return null;
    }
  }

  AF.greenhouse = {
    isGreenhouseHost,
    hasApplicationRoot,
    isApplicationFrame,
    isEmbedParent,
    embedIframe,
  };
})();
