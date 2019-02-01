/*global caches, fetch, Promise */
(function (worker) {
"use strict";

var PREFIX = 'mandelbrot',
	VERSION = '1.0',
	FILES = [
		'index.html',
		'style.css',
		'img/cancel.svg',
		'img/code.svg',
		'img/download.svg',
		'img/home.svg',
		'img/redo.svg',
		'img/undo.svg',
		'img/zoom-in.svg',
		'img/zoom-out.svg',
		'js/bigdecimal-all-last.js',
		'js/mandelbrot.js',
		'js/mandelbrot-worker.js'
	];

worker.addEventListener('install', function (e) {
	e.waitUntil(
		caches.open(PREFIX + ':' + VERSION).then(function (cache) {
			return cache.addAll(FILES);
		})
	);
});

worker.addEventListener('activate', function (e) {
	e.waitUntil(
		caches.keys().then(function (keys) {
			return Promise.all(keys.map(function (key) {
				if (key.indexOf(PREFIX + ':') === 0 && key !== PREFIX + ':' + VERSION) {
					return caches.delete(key);
				}
			}));
		})
	);
});

worker.addEventListener('fetch', function (e) {
	e.respondWith(caches.match(e.request, {ignoreSearch: true})
		.then(function (response) {
			return response || fetch(e.request);
		})
	);
});

})(this);