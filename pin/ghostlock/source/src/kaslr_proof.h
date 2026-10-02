#ifndef GHOSTLOCK_KASLR_PROOF_H
#define GHOSTLOCK_KASLR_PROOF_H

#include <stdint.h>

int ghostlock_parse_bugreport_kaslr(
    const char *value, uint64_t image_base, uint64_t alignment,
    uint64_t max_slide, uint64_t *base_out, uint64_t *slide_out);

#endif
