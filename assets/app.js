(() => {
  'use strict';
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));
  let toastTimer;
  const toast = message => {
    const element = $('#toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('visible'), 3000);
  };
  const themeButton = $('.theme-toggle');
  const syncThemeLabel = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeButton?.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    themeButton?.setAttribute('title', dark ? '切换到浅色模式' : '切换到深色模式');
  };
  syncThemeLabel();
  themeButton?.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('ink-theme', theme); } catch (_) {}
    syncThemeLabel();
  });

  // Every assignment remains an ordinary link; filtering only changes visibility.
  const cards = $$('[data-assignment]');
  const filterButtons = $$('[data-filter]');
  const searchInput = $('#search-input');
  let selectedCourse = '';
  const filter = () => {
    const query = (searchInput?.value || '').trim().toLocaleLowerCase('zh-CN');
    let visible = 0;
    cards.forEach(card => {
      const matches = (!selectedCourse || card.dataset.course === selectedCourse) && (!query || card.dataset.search.toLocaleLowerCase('zh-CN').includes(query));
      card.hidden = !matches;
      if (matches) visible++;
    });
    const count = $('#search-count');
    if (count) count.textContent = `${visible} 篇`;
    const empty = $('#empty-state');
    if (empty) empty.hidden = visible > 0;
  };
  filterButtons.forEach(button => button.addEventListener('click', () => {
    selectedCourse = button.dataset.filter;
    filterButtons.forEach(item => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    filter();
  }));
  searchInput?.addEventListener('input', filter);
  $('.search-toggle')?.addEventListener('click', event => {
    const box = $('#assignment-search');
    const opening = box.hidden;
    box.hidden = !opening;
    event.currentTarget.setAttribute('aria-expanded', String(opening));
    if (opening) searchInput.focus();
    else { searchInput.value = ''; filter(); }
  });
  searchInput?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('.search-toggle').click(); $('.search-toggle').focus(); }
  });
  $('#clear-filters')?.addEventListener('click', () => {
    searchInput.value = '';
    filterButtons[0]?.click();
    searchInput.focus();
  });
  const selected = new URLSearchParams(location.search).get('course');
  if (selected) {
    const section = $$('[data-course-section]').find(item => item.dataset.courseSection === selected);
    if (section) section.scrollIntoView();
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return true; } catch (_) {}
    }
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.append(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) {}
    input.remove();
    return copied;
  }
  $('[data-copy-link]')?.addEventListener('click', async () => {
    const link = $('link[rel=canonical]')?.href || location.href.split('#')[0];
    toast(await copyText(link) ? '作业链接已复制，可以提交给老师了。' : '复制未成功，请复制浏览器地址栏中的链接。');
  });
  $('[data-print]')?.addEventListener('click', () => window.print());

  const postBody = $('#post-content');
  if (postBody) {
    $$('table', postBody).forEach(table => {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-scroll';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', '数据表格，可横向滚动');
      table.before(wrapper);
      wrapper.append(table);
    });
    $$('pre', postBody).forEach(pre => {
      const code = $('code', pre);
      if (!code) return;
      const button = document.createElement('button');
      button.className = 'copy-code';
      button.type = 'button';
      button.textContent = '复制';
      button.setAttribute('aria-label', '复制这段代码');
      button.addEventListener('click', async () => toast(await copyText(code.textContent) ? '代码已复制。' : '复制未成功，请手动选择代码。'));
      pre.append(button);
    });
    const headings = $$('h2, h3', postBody);
    const toc = $('#toc');
    const usedIds = new Set($$('[id]').filter(item => !headings.includes(item)).map(item => item.id));
    headings.forEach((heading, index) => {
      let id = heading.id || `section-${index + 1}`;
      while (usedIds.has(id)) id += '-section';
      usedIds.add(id);
      heading.id = id;
      const anchor = document.createElement('a');
      anchor.href = '#' + encodeURIComponent(id);
      anchor.textContent = heading.textContent;
      if (heading.tagName === 'H3') anchor.className = 'toc-sub';
      toc?.append(anchor);
    });
    if (!headings.length) $('.toc-panel').hidden = true;
    const tocDetails = $('.toc-panel details');
    if (matchMedia('(max-width: 760px)').matches && tocDetails) tocDetails.open = false;
    const links = toc ? $$('a', toc) : [];
    let queued = false;
    let currentIndex = -1;
    const updateReading = () => {
      queued = false;
      const max = document.documentElement.scrollHeight - innerHeight;
      const progress = $('#reading-progress');
      if (progress) progress.style.width = `${max > 0 ? Math.min(100, Math.max(0, scrollY / max * 100)) : 0}%`;
      let active = 0;
      headings.forEach((heading, index) => { if (heading.getBoundingClientRect().top <= 130) active = index; });
      if (active !== currentIndex) {
        links.forEach((link, index) => {
          link.classList.toggle('is-current', index === active);
          if (index === active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
        });
        currentIndex = active;
      }
    };
    addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(updateReading); } }, { passive: true });
    addEventListener('resize', updateReading);
    updateReading();
    // Heading IDs are ready before resolving a direct section link.
    if (location.hash) {
      try { const target = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (target) requestAnimationFrame(() => target.scrollIntoView()); } catch (_) {}
    }
  }

  const form = $('#writing-form');
  if (form) {
    const status = $('#draft-status');
    const publishStatus = $('#publish-status');
    const draftStorageName = 'ink-local-assignment-draft-v1';
    const fields = ['title', 'course', 'date', 'slug', 'tags', 'summary', 'body'];
    const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const dateParts = Object.fromEntries(nowParts.map(part => [part.type, part.value]));
    const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    form.elements.date.value = today;
    form.elements.date.max = today;
    form.elements.slug.value = `homework-${Date.now().toString(36)}`;
    try {
      const draft = JSON.parse(localStorage.getItem(draftStorageName) || 'null');
      if (draft && typeof draft === 'object') {
        fields.forEach(field => { if (typeof draft[field] === 'string') form.elements[field].value = draft[field]; });
        status.textContent = '已恢复当前浏览器中的草稿，尚未公开。';
      }
    } catch (_) { status.textContent = '当前浏览器无法读取草稿，请及时下载 Markdown 备份。'; }
    let draftTimer;
    const values = () => Object.fromEntries(new FormData(form));
    const save = () => {
      try { localStorage.setItem(draftStorageName, JSON.stringify(values())); status.textContent = '草稿已保存在当前浏览器，尚未公开。'; }
      catch (_) { status.textContent = '自动保存不可用，请下载 Markdown 备份。'; }
    };
    form.addEventListener('input', () => { clearTimeout(draftTimer); draftTimer = setTimeout(save, 400); });
    form.addEventListener('change', save);
    addEventListener('pagehide', save);
    const documentFor = data => {
      const tags = data.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
      return ['---', `title: ${JSON.stringify(data.title.trim())}`, `date: ${data.date}`, `course: ${JSON.stringify(data.course.trim())}`, 'kind: "课程作业"', `tags: ${JSON.stringify(tags)}`, `summary: ${JSON.stringify(data.summary.trim())}`, '---', '', data.body.trim(), ''].join('\n');
    };
    const download = () => {
      if (!form.reportValidity()) return false;
      const data = values();
      const blob = new Blob([documentFor(data)], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${data.date}-${data.slug}.md`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      save();
      return true;
    };
    $('#download-markdown').addEventListener('click', () => { if (download()) toast('Markdown 已下载，可上传到仓库的 _posts 文件夹。'); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      save();
      const data = values();
      const params = new URLSearchParams({ filename: `_posts/${data.date}-${data.slug}.md`, value: documentFor(data) });
      const url = `https://github.com/ink-tx/ink-tx.github.io/new/main/?${params}`;
      if (url.length > 7500) {
        download();
        publishStatus.textContent = '正文较长，已改为下载 Markdown。请将文件上传到仓库的 _posts 文件夹，再提交更改。';
        const link = document.createElement('a');
        link.href = 'https://github.com/ink-tx/ink-tx.github.io/upload/main/_posts';
        link.textContent = ' 打开 GitHub 上传页 ↗';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        publishStatus.append(link);
      } else {
        const tab = window.open(url, '_blank', 'noopener,noreferrer');
        publishStatus.textContent = '请在 GitHub 检查内容并提交更改，提交后才会公开。';
        const link = document.createElement('a');
        link.href = url;
        link.textContent = ' 若新页面未打开，点击这里继续 ↗';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        publishStatus.append(link);
      }
    });
  }
})();
