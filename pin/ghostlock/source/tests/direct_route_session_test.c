#define _GNU_SOURCE

#include "direct_route_session.h"

#include <assert.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static void test_layout_is_disjoint_and_bounded(void) {
  const uintptr_t page = UINT64_C(0xffffffeb04540000);
  struct ghostlock_direct_route_layout previous = {0};

  for (unsigned int slot = 0; slot < GHOSTLOCK_DIRECT_ROUTE_SLOTS; slot++) {
    struct ghostlock_direct_route_layout layout;
    assert(ghostlock_direct_route_layout(page, slot, &layout));
    assert(layout.lock >= page);
    assert(layout.lock + GHOSTLOCK_DIRECT_LOCK_SIZE <= page + GHOSTLOCK_DIRECT_PAGE_SIZE);
    assert(layout.waiter >= layout.lock + GHOSTLOCK_DIRECT_LOCK_SIZE);
    assert(layout.waiter + GHOSTLOCK_DIRECT_WAITER_SIZE <= page + GHOSTLOCK_DIRECT_PAGE_SIZE);
    assert(layout.task >= page);
    assert(layout.task + GHOSTLOCK_DIRECT_TASK_SPAN <= page + GHOSTLOCK_DIRECT_PAGE_SIZE);
    assert((layout.lock & 7) == 0);
    assert((layout.waiter & 7) == 0);
    assert((layout.task & 7) == 0);
    if (slot != 0) {
      assert(layout.lock >= previous.waiter + GHOSTLOCK_DIRECT_WAITER_SIZE);
      assert(layout.task == previous.task);
    }
    assert(layout.waiter + GHOSTLOCK_DIRECT_WAITER_SIZE <= layout.task ||
           layout.waiter >= layout.task + GHOSTLOCK_DIRECT_TASK_SPAN);
    previous = layout;
  }

  struct ghostlock_direct_route_layout invalid;
  errno = 0;
  assert(!ghostlock_direct_route_layout(
      page, GHOSTLOCK_DIRECT_ROUTE_SLOTS, &invalid));
  assert(errno == ERANGE);
}

static void test_shared_cursor_never_reuses_a_slot_across_forks(void) {
  _Atomic unsigned int *cursor = mmap(
      NULL, sizeof(*cursor), PROT_READ | PROT_WRITE,
      MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  assert(cursor != MAP_FAILED);
  atomic_init(cursor, 0);

  int seen[GHOSTLOCK_DIRECT_ROUTE_SLOTS];
  for (unsigned int i = 0; i < GHOSTLOCK_DIRECT_ROUTE_SLOTS; i++) {
    seen[i] = 0;
  }

  int pipes[GHOSTLOCK_DIRECT_ROUTE_SLOTS][2];
  pid_t children[GHOSTLOCK_DIRECT_ROUTE_SLOTS];
  for (unsigned int i = 0; i < GHOSTLOCK_DIRECT_ROUTE_SLOTS; i++) {
    assert(pipe(pipes[i]) == 0);
    children[i] = fork();
    assert(children[i] >= 0);
    if (children[i] == 0) {
      close(pipes[i][0]);
      int slot = ghostlock_direct_route_claim(cursor);
      assert(write(pipes[i][1], &slot, sizeof(slot)) == sizeof(slot));
      close(pipes[i][1]);
      _exit(0);
    }
    close(pipes[i][1]);
  }

  for (unsigned int i = 0; i < GHOSTLOCK_DIRECT_ROUTE_SLOTS; i++) {
    int slot = -1;
    assert(read(pipes[i][0], &slot, sizeof(slot)) == sizeof(slot));
    close(pipes[i][0]);
    assert(slot >= 0 && slot < (int)GHOSTLOCK_DIRECT_ROUTE_SLOTS);
    assert(seen[slot] == 0);
    seen[slot] = 1;
    int status = 0;
    assert(waitpid(children[i], &status, 0) == children[i]);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  }

  errno = 0;
  assert(ghostlock_direct_route_claim(cursor) == -1);
  assert(errno == ENOSPC);
  assert(munmap((void *)cursor, sizeof(*cursor)) == 0);
}

int main(void) {
  test_layout_is_disjoint_and_bounded();
  test_shared_cursor_never_reuses_a_slot_across_forks();
  return 0;
}
