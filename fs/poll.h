#ifndef FS_POLL_H
#define FS_POLL_H
#include "kernel/fs.h"

struct real_poll {
    int fd;
};

struct poll {
    struct list poll_fds;
    struct real_poll real;
    int notify_pipe[2];
    int waiters; // if nonzero, notify_pipe exists

    // This is used to solve the race/UaF described here: https://lwn.net/Articles/520012/
    // thread 1: calls poll_wait, real_poll_wait returns an event with a pointer to a poll_fd
    // thread 2: calls poll_del_fd which frees the same poll_fd
    //
    // This can't be solved by adding locks because thread 1 could get
    // suspended after real_poll_wait returns but before it has a chance to
    // lock anything.
    //
    // An attempt was made to solve this with a Linux kernel patch, which
    // almost went in 3.7 but was backed out after discussion at
    // https://lkml.org/lkml/2012/10/16/302, and anyway wouldn't have solved
    // the problem on Darwin. My solution is to just not free poll_fds, and
    // instead move them to a freelist where they can be reused.
    struct list pollfd_freelist;

    lock_t lock;
};

struct poll_fd {
    // locked by containing struct poll
    struct fd *fd;
    // Guest fd number this entry was registered under (epoll only; -1 for
    // poll/select). epoll must key on the fd NUMBER, not the struct fd: a guest
    // can register two different fds that share one open file description (e.g.
    // stdout/stderr both pointing at the console, then dup'd), which Linux epoll
    // treats as distinct. Keying on struct fd wrongly returns EEXIST for the
    // second, which broke Bun's process.stderr init (claude-code crash).
    fd_t fd_no;
    struct list fds;
    int types;
    union poll_fd_info {
        void *ptr;
        int fd;
        uint64_t num;
    } info;
    // Used to implement edge-triggered notifications. When an event is
    // returned its bits are set here, and those bits are ignored on the next
    // call to poll_wait. The bits are cleared by poll_wakeup.
    int triggered_types;

    // EPOLLONESHOT: set true after an event fires so this fd is not reported
    // again until EPOLL_CTL_MOD re-arms it (which clears this). Crucially the
    // registration is KEPT (not freed) so the re-arming MOD can still find it —
    // freeing it made re-arm fail with ENOENT, which broke Bun's stdin reader
    // (claude-code became unresponsive to keypresses after the first event).
    bool disabled;

    // locked by containing struct fd
    struct poll *poll;
    struct list polls;
};

// these are defined in system headers somewhere
#undef POLL_IN
#undef POLL_OUT
#undef POLL_MSG
#undef POLL_ERR
#undef POLL_PRI
#undef POLL_HUP

#define POLL_READ 1
#define POLL_PRI 2
#define POLL_WRITE 4
#define POLL_ERR 8
#define POLL_HUP 16
#define POLL_NVAL 32
#define POLL_ONESHOT (1 << 30)
#define POLL_EDGETRIGGERED (1ul << 31)
struct poll_event {
    struct fd *fd;
    int types;
};
struct poll *poll_create(void);
// poll/select pass fd_no = -1 (they never search by fd number). epoll passes
// the guest fd number, which is the registration key (see struct poll_fd.fd_no).
bool poll_has_fd(struct poll *poll, fd_t fd_no);
int poll_add_fd(struct poll *poll, struct fd *fd, fd_t fd_no, int types, union poll_fd_info info);
int poll_mod_fd(struct poll *poll, struct fd *fd, fd_t fd_no, int types, union poll_fd_info info);
int poll_del_fd(struct poll *poll, struct fd *fd, fd_t fd_no);
// Indicates that the specified events have been triggered. Each call will
// generate a new edge-triggered notification.
// please do not call this while holding any locks you would acquire in your poll operation
void poll_wakeup(struct fd *fd, int events);
// Waits for events on the fds in this poll, and calls the callback for each one found.
// Returns the number of times the callback returned 1, or negative for error.
typedef int (*poll_callback_t)(void *context, int types, union poll_fd_info info);
int poll_wait(struct poll *poll, poll_callback_t callback, void *context, struct timespec *timeout);
// does not lock the poll because lock ordering, you must ensure no other
// thread will add or remove fds from this poll
void poll_destroy(struct poll *poll);

// for fd_close
void poll_cleanup_fd(struct fd *fd);

#endif
