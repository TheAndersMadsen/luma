#ifndef GHOSTLOCK_DIRECT_ROUTE_SESSION_H
#define GHOSTLOCK_DIRECT_ROUTE_SESSION_H

#include <stdatomic.h>
#include <stdint.h>

#define GHOSTLOCK_DIRECT_PAGE_SIZE 0x8000U
#define GHOSTLOCK_DIRECT_ROUTE_SLOTS 32U
#define GHOSTLOCK_DIRECT_ROUTE_BASE_OFF 0x100U
#define GHOSTLOCK_DIRECT_ROUTE_STRIDE 0x80U
#define GHOSTLOCK_DIRECT_LOCK_SIZE 0x20U
#define GHOSTLOCK_DIRECT_WAITER_SIZE 0x50U
#define GHOSTLOCK_DIRECT_TASK_OFF 0x2000U
#define GHOSTLOCK_DIRECT_TASK_SPAN 0x8f0U

struct ghostlock_direct_route_layout {
  uintptr_t lock;
  uintptr_t waiter;
  uintptr_t task;
};

int ghostlock_direct_route_layout(
    uintptr_t page, unsigned int slot,
    struct ghostlock_direct_route_layout *layout);

int ghostlock_direct_route_claim(_Atomic unsigned int *cursor);

#endif
