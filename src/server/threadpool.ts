// libuv's default pool has 4 threads. A file call stuck on a dropped network share holds a
// thread until the kernel gives up (minutes), so a few of them would stall every file call
// in the app, local ones included. The pool reads this once, on its first use, so this
// module must be imported before anything else.
process.env.UV_THREADPOOL_SIZE ??= '64';
