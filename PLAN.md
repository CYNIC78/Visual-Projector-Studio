# План реализации — Фаза 1

## Порядок работ

1. Prompt Node: структура данных + миграция + process()
2. Prompt Node: UI (табы, редактор, команды)
3. Asset Studio: Produce All + именование ассетов
4. Интеграция: gallery-to-reference drag-n-drop
5. Тул `configure_prompt_studio`

## Чеклист

- [x] 1. Prompt Node — data structure with tabs[]
- [x] 2. Prompt Node — backward-compat deserialize
- [x] 3. Prompt Node — strip {name:...} in process()
- [x] 4. Prompt Node — tab UI (bar + editor + add/del)
- [ ] 5. Asset Studio — Produce All iterates tabs
- [ ] 6. Asset Studio — displayResult() uses {name:...}
- [ ] 7. Index.html — load order check
- [ ] 8. Gallery drag-n-drop to reference zone
