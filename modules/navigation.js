'use strict';
// Future modules register their own navigation and route handler here.
// They share authentication, roles, database and the article catalog.
module.exports = [
  { id: 'articles', label: 'Artykuły', href: '/articles' },
  { id: 'projects', label: 'Projekty', href: '/projects' },
  { id: 'categories', label: 'Kategorie', href: '/categories', roles: ['admin', 'approver', 'technologist'] },
];
