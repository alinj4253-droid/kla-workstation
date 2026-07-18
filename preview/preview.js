const pages = [...document.querySelectorAll('[data-page]')];
const links = [...document.querySelectorAll('[data-route]')];

function showPage(name) {
  pages.forEach((page) => page.classList.toggle('is-hidden', page.dataset.page !== name));
  links.forEach((link) => {
    if (link.classList.contains('sidebar-link')) {
      link.classList.toggle('sidebar-link--active', link.dataset.route === name);
    }
  });
  window.location.hash = name;
}

links.forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  showPage(link.dataset.route);
}));

document.querySelectorAll('[data-open-chat]').forEach((card) => card.addEventListener('click', () => showPage('chat')));
document.querySelector('#home-form').addEventListener('submit', (event) => { event.preventDefault(); showPage('chat'); });
document.querySelector('#chat-form').addEventListener('submit', (event) => event.preventDefault());
document.querySelector('#close-preview').addEventListener('click', () => {
  document.querySelector('.chat-workspace').classList.add('chat-workspace--preview-closed');
  document.querySelector('.artifact-preview').remove();
});

showPage(window.location.hash === '#chat' ? 'chat' : 'home');
