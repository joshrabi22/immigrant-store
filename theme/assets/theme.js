// IMMIGRANT Theme JS

// Mobile menu toggle
document.addEventListener('click', (e) => {
  if (e.target.closest('.mobile-toggle')) {
    document.querySelector('.mobile-nav')?.classList.toggle('open');
  }
});

// Size selector
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('size-option')) {
    document.querySelectorAll('.size-option').forEach(el => el.classList.remove('active'));
    e.target.classList.add('active');
    const variantId = e.target.dataset.variantId;
    const input = document.querySelector('input[name="id"]');
    if (input && variantId) input.value = variantId;
  }
});
