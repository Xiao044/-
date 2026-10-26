const workflow = document.querySelector('.workflow-panel');
const topbar = document.querySelector('.topbar');
const stepStrip = document.querySelector('.step-scroll');
const flowSteps = [...document.querySelectorAll('.flow-step')];
const workflowCanvas = document.querySelector('.workflow-canvas');
const workflowNodes = [...document.querySelectorAll('[data-workflow-node]')];
const connectors = [...document.querySelectorAll('[data-connector]')];

if (workflow && topbar && workflowCanvas && flowSteps.length && workflowNodes.length && 'IntersectionObserver' in window) {
  const visible = new Map();
  let nodeObserver;
  let compactObserver;
  let focusY = window.innerHeight * 0.55;

  const focusStep = (index) => {
    const activeIndex = Math.max(0, Math.min(flowSteps.length - 1, index));
    flowSteps.forEach((step, stepIndex) => step.classList.toggle('scroll-focus', stepIndex === activeIndex));
    connectors.forEach((connector, connectorIndex) => connector.classList.toggle('is-connected', connectorIndex < activeIndex));

    const marker = workflowNodes[activeIndex]?.querySelector('.workflow-node-marker');
    const activeNode = workflowNodes[activeIndex];
    if (marker && activeNode) {
      const progress = Math.max(0, activeNode.offsetTop + marker.offsetHeight / 2 - 18);
      workflowCanvas.style.setProperty('--connection-progress', `${progress}px`);
    }

    const activeStep = flowSteps[activeIndex];
    if (!activeStep || !stepStrip) return;
    const stripBounds = stepStrip.getBoundingClientRect();
    const stepBounds = activeStep.getBoundingClientRect();
    if (stepBounds.left < stripBounds.left || stepBounds.right > stripBounds.right) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const left = stepStrip.scrollLeft + stepBounds.left - stripBounds.left;
      stepStrip.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  };

  const refreshFocus = () => {
    const candidates = [...visible.entries()]
      .filter(([, isVisible]) => isVisible)
      .map(([node]) => ({ node, step: Number(node.dataset.workflowNode) }));
    if (!candidates.length) return;

    const nearest = candidates.reduce((best, candidate) => {
      const bounds = candidate.node.getBoundingClientRect();
      const distance = Math.abs(bounds.top + Math.min(bounds.height, window.innerHeight * 0.7) / 2 - focusY);
      return distance < best.distance ? { ...candidate, distance } : best;
    }, { ...candidates[0], distance: Infinity });
    focusStep(nearest.step);
  };

  const observeNodes = () => {
    nodeObserver?.disconnect();
    visible.clear();
    const stackHeight = topbar.getBoundingClientRect().height + workflow.getBoundingClientRect().height;
    const bandTop = Math.min(stackHeight + 8, window.innerHeight * 0.42);
    const bandBottom = Math.max(bandTop + 48, window.innerHeight * 0.72);
    focusY = (bandTop + Math.min(bandBottom, window.innerHeight)) / 2;
    nodeObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => visible.set(entry.target, entry.isIntersecting));
      refreshFocus();
    }, {
      rootMargin: `-${Math.round(bandTop)}px 0px -${Math.max(0, Math.round(window.innerHeight - bandBottom))}px 0px`,
      threshold: 0
    });
    workflowNodes.forEach((node) => nodeObserver.observe(node));
  };

  const observeCompactState = () => {
    compactObserver?.disconnect();
    const topOffset = Math.round(topbar.getBoundingClientRect().height);
    compactObserver = new IntersectionObserver(([entry]) => {
      workflow.classList.toggle('is-condensed', !entry.isIntersecting);
    }, {
      rootMargin: `-${topOffset}px 0px 0px 0px`,
      threshold: 0
    });
    const intro = document.querySelector('.welcome-row');
    if (intro) compactObserver.observe(intro);
  };

  observeNodes();
  observeCompactState();

  const stepObserver = new MutationObserver(refreshFocus);
  flowSteps.forEach((step) => stepObserver.observe(step, { attributes: true, attributeFilter: ['aria-current'] }));

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      observeNodes();
      observeCompactState();
      refreshFocus();
    });
  }, { passive: true });
}
