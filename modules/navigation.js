'use strict';
// Future modules register their own navigation and route handler here.
// They share authentication, roles, database and the article catalog.
module.exports = [
  { id: 'articles', label: 'Artykuły', href: '/articles' },
  { id: 'projects', label: 'Projekty / próby', href: '/projects' },
];
