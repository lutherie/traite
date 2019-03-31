let CACHED_PAGES = {}

const dbp = new Promise((resolve, reject) => {
  const openreq = window.indexedDB.open('page-cache', 1)
  openreq.onerror = () => reject(openreq.error)
  openreq.onsuccess = () => resolve(openreq.result)
  openreq.onupgradeneeded = () => openreq.result.createObjectStore('idb')
})

const call = async (type, method, ...args) => {
  const db = await dbp
  const transaction = db.transaction('idb', type)
  const store = transaction.objectStore('idb')

  return new Promise((resolve, reject) => {
    const req = store[method](...args)
    transaction.oncomplete = () => resolve(req)
    transaction.onabort = transaction.onerror = () => reject(transaction.error)
  })
}

const get = async key => (await call('readonly', 'get', key)).result
const set = (key, value) =>
  value === undefined
    ? call('readwrite', 'delete', key)
    : call('readwrite', 'put', value, key)

const getContent = async name => {
  if (!name) return console.error(Error('requested an empty page'))
  const path = `/pages/${encodeURIComponent(name)}`
  const res = await fetch(path)
  const text = await res.text()
  const dom = new DOMParser().parseFromString(text, 'text/html')
  const elem = dom.body.firstElementChild
  if (!elem) return ''
  elem.firstElementChild && elem.firstElementChild.remove()
  return elem.innerHTML.trim()
}

const parseName = src => {
  const [, index, locale, title] = src.split(/([0-9]{2})-([a-z]{2})/)
  const name = src.slice(0, -3)
  return {
    index: Number(index),
    locale,
    title: title.trim().slice(0, -3),
    name,
    search: `?${new URLSearchParams({ page: name })}`,
  }
}

const displayPage = innerHTML => {
  if (!innerHTML) return
  document.getElementById('article').innerHTML = innerHTML
  for (const img of document.getElementsByTagName('img')) {
    try {
      const className = img.src.split('#')[1]
      className && img.classList.add(className)
    } catch (err) {
      console.error(err)
    }
  }
}

const generateMenu = (pages, locale = 'en') => {
  document.getElementById('nav').innerHTML =
    pages
      .filter(p => p.locale === locale)
      .sort((a, b) => a.index - b.index)
      .map(
        p =>
          `<li><a data-page=${encodeURIComponent(p.name)} href="${
            location.pathname
          }${p.search}">${p.title}</a></li>`,
      )
      .join('\n') +
    `<li><a href="https://lutherie.github.io">François Denis</a></li>`
}

const loadPage = name => {
  const page = CACHED_PAGES[name]
  if (!page) return page

  const locale = name ?  name.split(/[0-9]{2}-([a-z]{2})/)[1] : 'en'

  const localeButton = document.getElementById(locale)
  localeButton.disabled = true
  localeButton.alt.disabled = false

  get(page.sha)
    .then(async actualContent => {
      displayPage(actualContent)
      const content = await getContent(name)
      if (actualContent !== content) {
        displayPage(content)
        return loadContent()
      }
    })
    .catch(console.error)

  return page
}

window.addEventListener('click', async e => {
  if (e.button || e.buttons) return
  console.dir(e.target)
  if (!e.target.dataset.page) return
  const clickedName = decodeURIComponent(e.target.dataset.page)
  const currentName = new URL(location).searchParams.get('page')
  if (clickedName === currentName) {
    e.preventDefault()
    return
  }
  const page = loadPage(clickedName)
  if (!page) return
  e.preventDefault()
  history.pushState(null, page.name, page.search)
})

window.addEventListener('popstate', async e => {
  loadPage(new URL(location).searchParams.get('page'))
})

let queryPages

const loadContent = () => {
  queryPages = fetch(
    'https://api.github.com/repos/lutherie/traite/contents/pages',
  )

  return get('pages')
    .then(handleLoading)
    .then(console.log)
    .catch(console.error)
}

const handleLoading = async (cachedPages = {}) => {
  // init pages from cache
  const { searchParams } = new URL(location)
  const selectedPage = searchParams.get('page')
  const locale = selectedPage ?  selectedPage.split(/[0-9]{2}-([a-z]{2})/)[1] : 'en'

  const localeButton = document.getElementById(locale)
  localeButton.disabled = true
  localeButton.alt.disabled = false

  CACHED_PAGES = cachedPages
  generateMenu(Object.values(cachedPages))
  if (selectedPage) {
    const page = cachedPages[selectedPage]
    displayPage(await (page ? get(page.sha) : getContent(selectedPage)))

    console.log('show page', { page })
  } else {
    console.log('no selectedPage')
  }

  const res = await queryPages
  res.ok || console.error(Error('Github request failed'))
  const pages = (res.ok ? await res.json() : [])
    .filter(p => p.type === 'file' && p.name.endsWith('.md'))
    .map(({ sha, name }) => ({ ...parseName(name), sha }))

  const work = []
  const cache = pages.reduce(
    (a, page) => ({
      ...a,
      [page.name]: {
        ...page,
        ...pages
          .filter(p => p.index === page.index)
          .reduce((b, p) => ({ ...b, [p.locale]: p.name }), {}),
      },
    }),
    {},
  )
  work.push(set('pages', cache))

  console.log(cache)

  for (const page of pages) {
    const cachedPage = cachedPages[page.name]
    const cachedSha = cachedPage && cachedPage.sha
    if (page.sha !== cachedSha) {
      const content = (await getContent(page.name)) || page.name
      if (page.name === selectedPage) {
        displayPage(content)
      }
      work.push(set(page.sha, content))
      cachedSha && work.push(set(cachedSha, undefined))
    }
  }

  generateMenu(pages, locale)
  CACHED_PAGES = cache

  return Promise.all(work)
}

// Load initial content
loadContent()

const enButton = document.getElementById('en')
const frButton = document.getElementById('fr')
enButton.alt = frButton
frButton.alt = enButton
enButton.addEventListener('click', e => switchLocale('en'))
frButton.addEventListener('click', e => switchLocale('fr'))

const locales = { fr: frButton, en: enButton }
const altLocales = { en: frButton, fr: enButton }

const switchLocale = async locale => {
  const currentName = new URL(location).searchParams.get('page')
  const currentPage = CACHED_PAGES[currentName] || Object.keys(CACHED_PAGES)[0]
  if (currentPage.locale === locale) return
  const nextPage = await loadPage(currentPage[locale])
  console.log('switching to', { locale, currentName, currentPage, nextPage })
  if (!nextPage) {
    console.error('no alternate page', currentPage, locale)
  }
  generateMenu(Object.values(CACHED_PAGES), locale)
  history.pushState(null, nextPage.name, nextPage.search)
  return 
}
