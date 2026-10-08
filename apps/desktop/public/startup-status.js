// This classic script still runs when the application module fails to parse.
(function () {
  function showFailure(detail) {
    if (!document.getElementById('startup-status')) return;
    document.getElementById('startup-title').textContent = '页面加载失败';
    document.getElementById('startup-detail').textContent = detail || '前端资源未能加载，请重新加载页面。';
    document.getElementById('startup-retry').hidden = false;
  }
  document.getElementById('startup-retry').addEventListener('click', function () {
    window.location.reload();
  });
  window.addEventListener('error', function (event) {
    if (event.target instanceof HTMLScriptElement) {
      showFailure('前端脚本未能加载，请检查预览服务后重新加载。');
    } else if (event.message) {
      showFailure(event.message);
    }
  }, true);
  window.addEventListener('unhandledrejection', function () {
    showFailure('页面初始化失败，请重新加载，或将浏览器错误信息反馈给开发人员。');
  });
})();
