'use strict';
// Future modules register their own navigation and route handler here.
// They share authentication, roles, database and the article catalog.
module.exports = [
  { id: 'articles', label: 'Artykuły', href: '/articles' },
  { id: 'projects', label: 'Projekty / próby', href: '/projects' },
  { id: 'warehouse', label: 'MAGAZYN', children: [
    { id: 'production', label: 'Stan bieżący', href: '/production' },
    { id: 'catalog', label: 'Kartoteka', href: '/warehouse' },
    { id: 'shipments', label: 'Wysyłka', href: '/shipments' },
  ] },
  { id: 'settings', label: 'Ustawienia magazynu', href: '/settings', roles: ['admin','approver'] },
  { id: 'archive', label: 'Archiwum · 30 dni', href: '/archive' },
];
